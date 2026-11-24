"""Compile a transparent anime portrait from its visible semantic masks.

Visible pixels stay in their original locations. Hidden support is limited to
opaque overlap and sampled from the owner's adjacent source pixels. This is
not a generic solution for profiles, crossed arms, or unobserved hands.
"""
import json
import sys
from pathlib import Path

import cv2 as cv
import numpy as np
from PIL import Image, ImageDraw

from anime_eye_regions import eye_regions
from facial_materials import remove_brow_backprint


def nearest(valid):
    _, labels = cv.distanceTransformWithLabels((~valid).astype(np.uint8),
        cv.DIST_L2, cv.DIST_MASK_5, labelType=cv.DIST_LABEL_PIXEL)
    indices = np.zeros(labels.max()+1, np.int32)
    indices[labels[valid]] = np.flatnonzero(valid)
    return np.unravel_index(indices[labels], valid.shape)


def elbow_fabric(source, sleeve, anchors):
    """Paint compression folds inside the registered sleeve silhouette."""
    shoulder, elbow, wrist = (np.asarray(anchors[k], float) for k in ("shoulder", "elbow", "wrist"))
    span = np.linalg.norm(wrist-shoulder)
    axis = (wrist-shoulder)/span
    rows, cols = np.ogrid[:sleeve.shape[0], :sleeve.shape[1]]
    x, y = cols-elbow[0], rows-elbow[1]
    along = (x*axis[0]+y*axis[1])/span
    across = (-x*axis[1]+y*axis[0])*anchors["direction"]/span
    cloth = sleeve & (source[:,:,3]>=250) & (abs(along)<.14)
    interior = cv.distanceTransform(cloth.astype(np.uint8),cv.DIST_L2,3)
    if not cloth.any() or interior.max()<4:
        return None
    tone = np.median(source[cloth,:3],axis=0)
    if np.median(tone)<18 or np.median(tone)>237:
        return None
    cross_section = across[cloth & (abs(along)<.04)]
    if not cross_section.size:
        return None
    width = np.percentile(cross_section,95)
    if width<.025:
        return None
    u = across/width
    crease = along - .045*(1-u)**2
    fold = np.zeros_like(source)
    support = np.clip((u+.12)/.28,0,1)*np.clip((1.01-u)/.28,0,1)
    support *= np.clip((interior-1.5)/(span*.025),0,1)
    for offset, strength in [(-.034,1),(.028,.66)]:
        trough = np.exp(-((crease-offset)/.011)**2)
        ridge = np.exp(-((crease-offset-.019)/.015)**2)
        weight = np.minimum(1,(trough+ridge)*support*strength)
        pigment = tone + (ridge-trough)[:,:,None]*min(39,np.median(tone)*.47)
        alpha = np.round(weight*255).astype(np.uint8)
        take = alpha>fold[:,:,3]
        fold[take,:3] = np.clip(pigment[take],0,255)
        fold[take,3] = alpha[take]
    return fold if (fold[:,:,3]>32).any() else None


def sleeve_hair_continuation(hair, sleeve, opaque, rgb, sat, value, anchors, face_width):
    """Join visible ends of a light lock only across a supported sleeve overlap."""
    (sx, sy), (ex, ey), (wx, wy) = (anchors[k] for k in ("shoulder", "elbow", "wrist"))
    # This is the outside edge of the lowered sleeve, not the interior
    # highlight or the other side of the sleeve. Use its local direction.
    rows, cols = np.ogrid[:hair.shape[0], :hair.shape[1]]
    axis = np.interp(rows.ravel(), [sy, ey, wy], [sx, ex, wx])[:,None]
    outer = (cols < axis-face_width*.10) & (rows > sy) & (rows < wy)
    bright = hair & outer & (sat < 62) & (value > 175)
    count, labels, stats, centers = cv.connectedComponentsWithStats(bright.astype(np.uint8))
    if count < 3:
        return None
    lead = 1+int(np.argmax(stats[1:,4]))
    y0 = stats[lead,1]+stats[lead,3]-1
    base = (labels==lead) & (rows >= y0-max(6,round(face_width*.085)))
    x0 = float(np.median(np.nonzero(base)[1]))
    # Require a detached, naturally tapered visible end close to the same
    # sweep. A highlight beyond the sleeve axis cannot be selected.
    candidates = [i for i in range(1,count) if i!=lead
                  and max(10,face_width*.10) <= stats[i,4] <= face_width*2
                  and y0+face_width*.035 < centers[i,1] < y0+face_width*.40
                  and x0-face_width*.22 < centers[i,0] < x0+face_width*.10]
    if not candidates:
        return None
    tip = max(candidates,key=lambda i:centers[i,1])
    ty,tx = np.nonzero(labels==tip)
    end_x = float(np.percentile(tx,60))
    end_y = float(np.percentile(ty,88))
    span = end_y-y0
    if span < 3:
        return None
    overlap = max(8,round(face_width*.30))
    start_y = y0-overlap
    start = (labels==lead) & (abs(rows-start_y)<=2)
    if not start.any():
        return None
    start_x = float(np.percentile(np.nonzero(start)[1],80))
    u = np.clip((rows-start_y)/(end_y-start_y),0,1)
    arc = np.sin(np.pi*u)
    center = (1-u)*start_x+u*end_x+face_width*.102*arc
    width = np.maximum(2,face_width*(.105*(1-u)**.82+.022*arc))
    cross = (cols-center)/width
    active = (abs(cross)<1) & (rows>=start_y) & (rows<=end_y)
    # Pixels near the sleeve contour on the enclosed side belong to the
    # sleeve ink. Carry them with the cloth when it moves off the hair.
    contact = cv.dilate(sleeve.astype(np.uint8),np.ones((7,7),np.uint8))>0
    rim = active & hair & opaque & contact & (sat<68) & (value<208)
    fill = active & opaque & ((sleeve & ~hair) | rim)
    if np.count_nonzero(fill) < span*2:
        return None
    # Match the visible pigments at both ends; a broad shadow and a fine
    # darker edge give the uncovered continuation volume.
    hi = np.median(rgb[base],axis=0)
    lo = np.median(rgb[labels==tip],axis=0)
    t = u[fill.nonzero()[0],0,None]
    q = cross[fill,None]
    pigment = (1-t)*hi+t*lo - 16*np.maximum(q+.04,0)**1.45 - 53*np.clip((q-.81)*5,0,1)
    taper = np.clip(np.minimum(t/.15,(1-t)/.10),0,1)
    # Keep the join opaque where the fill meets a visible end. Taper only
    # the exposed sides and tips of the inferred strand.
    end_distance = cv.distanceTransform((~((labels==lead)|(labels==tip))).astype(np.uint8),cv.DIST_L2,3)
    contact = np.clip(1-end_distance[fill,None]/max(3,face_width*.028),0,1)
    taper = np.maximum(taper,contact)*np.clip((1-abs(q))/.20,0,1)
    return fill, np.clip(pigment,0,255).astype(np.uint8), taper[:,0], rim


def return_garment_shadows(hair, garments, value, shoulder_y, wrist_y, face_width):
    """Keep detached, dark inner-sleeve shading with the touching garment."""
    fabric = np.logical_or.reduce(garments)
    if not fabric.any():
        return
    count, labels, stats, _ = cv.connectedComponentsWithStats(hair.astype(np.uint8))
    near = nearest(fabric)
    margin = max(2,round(face_width*.025))
    close = cv.dilate(fabric.astype(np.uint8),cv.getStructuringElement(cv.MORPH_ELLIPSE,(2*margin+1,2*margin+1))).astype(bool)
    for label in range(1,count):
        x,y,w,h,area = stats[label]
        if y<shoulder_y or y+h>wrist_y or area>face_width**2*.12:
            continue
        tile = np.s_[y:y+h,x:x+w]
        piece = labels[tile]==label
        if np.median(value[tile][piece])>=222 or np.mean(close[tile][piece])<.18:
            continue
        garment_index = tuple(coord[tile] for coord in near)
        for garment in garments:
            garment[tile] |= piece & garment[garment_index]
        hair[tile] &= ~piece


def hand_landmarks(hand, wrist):
    # Measure convex turns along the distal skin contour, beyond the palm.
    shape = cv.morphologyEx(hand.astype(np.uint8),cv.MORPH_CLOSE,np.ones((5,5),np.uint8))
    contours,_ = cv.findContours(shape,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_NONE)
    contour = max(contours,key=cv.contourArea)[:,0].astype(float)
    radius = np.linalg.norm(contour-wrist,axis=1)
    size = radius.max()
    window = max(4,round(size*.059))
    a = np.roll(contour,window,axis=0)-contour
    b = np.roll(contour,-window,axis=0)-contour
    cosine = np.sum(a*b,axis=1)/np.maximum(1,np.linalg.norm(a,axis=1)*np.linalg.norm(b,axis=1))
    convex = a[:,0]*b[:,1]-a[:,1]*b[:,0]>0
    tips = []
    for i in np.argsort(cosine)[::-1]:
        if not convex[i] or radius[i]<size*.59 or cosine[i]<.15:
            continue
        tip = contour[i]
        if any(np.linalg.norm(tip-other)<size*.17 for other in tips):
            continue
        tips.append(tip)
        if len(tips)==4:
            break
    if len(tips)<2:
        raise ValueError("手部轮廓缺少可区分的原图指尖")
    return [[int(v) for v in tip] for tip in tips]


def close_upper_lash(source, upper, aperture):
    """Bend the painted upper lash onto the closed lid, keeping its pigment and forks."""
    _, ay, _, ah = aperture
    ys, xs = np.nonzero(upper)
    columns = np.unique(xs)
    centers = np.array([np.median(ys[xs == x]) for x in columns])
    x = np.arange(upper.shape[1])
    u = np.clip((x - columns[0]) / (columns[-1] - columns[0]), 0, 1)
    source_center = np.interp(x, columns, centers)
    broad_center = cv.GaussianBlur(source_center.astype(np.float32)[None, :], (0, 0), max(1, ah*.12))[0]
    source_center = broad_center*.82 + source_center*.18
    closed_center = ay + ah*(.65 + .20*4*u*(1-u))
    height_scale = .68 + .22*abs(2*u - 1)
    xmap, ymap = np.meshgrid(x.astype(np.float32), np.arange(upper.shape[0], dtype=np.float32))
    ymap[:] = source_center + (ymap - closed_center) / height_scale
    paint = source.astype(np.float32)
    paint[:, :, 3] *= upper
    paint[:, :, :3] *= paint[:, :, 3:] / 255
    closed = cv.remap(paint, xmap, ymap, cv.INTER_LINEAR, borderMode=cv.BORDER_CONSTANT)
    closed[:, :, :3] *= 255 / np.maximum(1, closed[:, :, 3:])
    return np.clip(closed, 0, 255).astype(np.uint8)


def repair_collar(output, entries, canvas):
    """Keep detached collar color on the garment, and remove concealed duplicates."""
    by_id = {p["id"]: p for p in entries}
    targets = ("face", "hair-back", "bodice")
    if any(name not in by_id for name in targets):
        return []
    width, height = canvas["width"], canvas["height"]
    layers = {}
    occupied = np.zeros((height,width), dtype=bool)
    opaque = np.zeros((height,width), dtype=bool)
    coverage = {}
    for p in reversed(entries):
        if not p["visible"] or p.get("opacity") == 0:
            continue
        name = p["id"]
        plate = Image.new("RGBA", (width, height))
        with Image.open(output/(p["id"]+".png")) as pixels:
            plate.paste(pixels, (p["rect"]["left"], p["rect"]["top"]))
        alpha = np.asarray(plate.getchannel("A"))
        if name in targets:
            layers[name] = np.array(plate)
        if name in ("hair-back", "bodice"):
            coverage[name] = opaque.copy()
        if name != "face":
            occupied |= alpha > 0
        if p.get("opacity", 1) == 1:
            opaque |= alpha == 255
    if any(name not in layers for name in targets):
        return []
    face = layers["face"]
    def islands(plate):
        _, labels, stats, _ = cv.connectedComponentsWithStats(
            (plate[:,:,3] > 0).astype(np.uint8), connectivity=8)
        return labels, stats
    labels, stats = islands(face)
    if len(stats) < 2:
        return []
    left, top, head_width, head_height, _ = max(stats[1:], key=lambda box: box[4])
    chin = top + head_height
    bodice = layers["bodice"]
    near_bodice = cv.dilate((bodice[:,:,3] > 0).astype(np.uint8), np.ones((3,3), np.uint8)).astype(bool)
    repairs, changed = [], set()
    for index, (x,y,w,h,area) in enumerate(stats[1:], 1):
        if not (chin <= y <= chin + head_width*.10 and x >= left + head_width*.23
                and x+w <= left + head_width*.77 and w <= head_width*.20
                and h <= head_width*.20 and 10 <= area <= head_width**2*.012):
            continue
        mask = labels == index
        if np.any(mask & occupied) or not np.any(mask & near_bodice) or np.any(face[mask,3] == 255):
            continue
        bodice[mask] = face[mask]
        face[mask] = 0
        changed.update(("face", "bodice"))
        repairs.append({"layer":"face","operation":"move_to_bodice","box":[int(v) for v in (x,y,w,h,area)]})
    for name in ("hair-back", "bodice"):
        plate = layers[name]
        covered = coverage[name]
        labels, stats = islands(plate)
        remaining = stats[1:,4].sum()
        for index, (x,y,w,h,area) in enumerate(stats[1:], 1):
            if not (chin-head_width*.25 <= y <= chin+head_width*.22 and x+w >= left-head_width*.08
                    and x <= left+head_width*1.08 and w <= head_width*.25
                    and h <= head_width*.12 and 10 <= area <= head_width**2*.006):
                continue
            mask = labels == index
            if area == remaining or not np.all(covered[mask]):
                continue
            plate[mask] = 0
            remaining -= area
            changed.add(name)
            repairs.append({"layer":name,"operation":"remove_occluded_island","box":[int(v) for v in (x,y,w,h,area)]})
    for name in sorted(changed):
        plate = layers[name]
        y, x = np.nonzero(plate[:,:,3])
        x0, x1, y0, y1 = int(x.min()), int(x.max())+1, int(y.min()), int(y.max())+1
        Image.fromarray(plate[y0:y1,x0:x1]).save(output/(name+".png"))
        by_id[name]["rect"] = {"left":x0,"top":y0,"width":x1-x0,"height":y1-y0}
    return repairs


def main(source_path, output, framing, *mask_paths):
    source = np.asarray(Image.open(source_path).convert("RGBA"))
    h, w = source.shape[:2]
    rgb, alpha = source[:, :, :3], source[:, :, 3]
    # Some cutouts retain small alpha variations even well inside the
    # silhouette. Only an enclosed near-opaque neighborhood may hide a
    # backing in that case; preserve all fractional silhouette edges.
    opaque = alpha >= 254 if alpha.max()==255 else (
        cv.erode((alpha>=240).astype(np.uint8),np.ones((5,5),np.uint8),
                 borderType=cv.BORDER_CONSTANT,borderValue=0)>0)
    hsv = cv.cvtColor(rgb, cv.COLOR_RGB2HSV)
    hue, sat, value = np.moveaxis(hsv, -1, 0)
    yy, xx = np.ogrid[:h, :w]
    masks = {p.stem: np.asarray(Image.open(p).convert("RGBA"))[:, :, 3] > 0
             for p in mask_paths}
    required = {"face", "eyes", "mouth", "hair", "handwear", "topwear"}
    if not required <= masks.keys() or alpha.min() != 0:
        raise ValueError("需要透明正面插画及脸、眼、嘴、头发、衣身、完整袖臂的可见分割")

    def rect(m):
        x, y, a, b = cv.boundingRect(m.astype(np.uint8))
        if a < 2 or b < 2:
            raise ValueError("未找到独立部件")
        return x, y, a, b

    def spread(m, radius):
        k = 2*radius+1
        return cv.dilate(m.astype(np.uint8), cv.getStructuringElement(cv.MORPH_ELLIPSE,(k,k))) > 0

    def largest(m):
        n, labels, stats, _ = cv.connectedComponentsWithStats(m.astype(np.uint8))
        if n < 2:
            raise ValueError("找不到连贯的原画区域")
        return labels == 1 + int(np.argmax(stats[1:,4]))

    parts = []
    claimed = np.zeros_like(alpha, bool)

    def add(name, tags, m, *, hidden=False, pixels=None, rig=None):
        if not hidden:
            m = m & (alpha > 0) & ~claimed
            claimed[m] = True
        rect(m)
        parts.append(dict(id=name, tags=tags, mask=m, hidden=hidden, pixels=pixels, rig=rig))

    def stroke(mask, points, color, width):
        x,y,a,b = rect(mask)
        tile = Image.new("RGBA", (a,b))
        ImageDraw.Draw(tile).line([(round(px-x),round(py-y)) for px,py in points],
                                 fill=tuple(map(int,color))+(255,), width=width)
        arr = np.zeros_like(source)
        arr[y:y+b,x:x+a] = np.asarray(tile)
        return arr

    fx, fy, fw, fh = rect(masks["face"])
    cx = fx+fw/2
    regions = eye_regions(masks["eyes"])
    if len(regions) != 2:
        raise ValueError("没有两块位置与面积可比的正面眼部")
    lower_lash_absent = []
    amber_sides = set()
    for region in regions:
        side = {"r":"right","l":"left"}[region["semantic"][-1]]
        l,t,r,b = [round(v*d) for v,d in zip(region["box"],[w,h,w,h])]
        sl = np.s_[t:b,l:r]
        support = largest(masks["eyes"][sl])
        local_hue, local_sat, local_v = hue[sl], sat[sl], value[sl]
        # Red/warm upper lash is distinct from the cool iris on this portrait
        # family; dark pixels on the green iris rim are not a lower lid.
        cool = support & (local_hue >= 35) & (local_hue < 145) & (local_sat >= 28)
        iris = largest(cool) if cool.any() else np.zeros_like(support)
        amber = not iris.any() or cv.boundingRect(iris.astype(np.uint8))[2] < (r-l)*.25
        if amber:
            amber_sides.add(side)
            amber_core = support & (local_hue >= 9) & (local_hue < 35) & (local_sat > 99) & (local_v > 90)
            ax0, ay0, aw0, ah0 = rect(largest(amber_core))
            rows, cols = np.ogrid[:b-t,:r-l]
            center = ax0+(aw0-1)*.5
            # Extend the saturated lower iris into the darker upper iris,
            # bounded by the same width and the curve under the upper lash.
            iris_top = ay0-ah0*.70+ah0*.23*((cols-center)/(aw0*.53))**2
            iris = support & (abs(cols-center)<=aw0*.53) & (rows>=iris_top) & (rows<ay0+ah0) & (
                (local_sat>=63) | (local_v<116))
            iris = largest(iris)
        ix, iy, iw, ih = rect(iris)
        if iw < (r-l)*.25 or ih < (b-t)*.34:
            raise ValueError("虹膜没有足够且连贯的源色证据")
        contours, _ = cv.findContours(iris.astype(np.uint8), cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
        interior = np.zeros_like(iris,np.uint8)
        cv.drawContours(interior, contours, -1, 1, cv.FILLED)
        iris = interior.astype(bool) & support
        rows = np.arange(b-t)[:,None]
        warm = (local_hue < 30) | (local_hue >= 160)
        lash_pigment = (warm & (local_sat > 44)) | (amber & (local_v < 116))
        upper = largest(support & ~iris & lash_pigment & (local_v < 185) & (rows < iy+.47*ih))
        if rect(upper)[2] < iw*.78:
            raise ValueError("上睫线缺少横跨虹膜的独立原画笔触")
        # Keep the semantic eye silhouette; remove warm skin below the lash.
        # Only keep nearby, neutral pixels connected to the two verified flanks.
        white_candidates = support & ~iris & ~upper & (local_sat < 43) & (local_v > 141) & (rows >= iy-1)
        columns = np.arange(r-l)[None,:]
        white = np.zeros_like(iris)
        for flank in [columns < ix+.34*iw, columns >= ix+.66*iw]:
            near = cv.dilate(iris.astype(np.uint8),np.ones((7,7),np.uint8)) > 0
            component = largest(white_candidates & flank & near)
            if rect(component)[3] < ih*.20:
                raise ValueError("眼白边缘不连贯，不能把肤色或发色纳入眼白")
            white |= component
        aperture = np.zeros_like(iris,np.uint8)
        cv.fillConvexPoly(aperture,cv.convexHull(cv.findNonZero((white|iris).astype(np.uint8))),1)
        white |= aperture.astype(bool) & white_candidates
        # Assign the thin antialiased aperture rim to the moving eye, not
        # the face plate. The source segmentation provides the outer limit.
        # Only recognize an independent lower stroke when it spans most of
        # the aperture outside the iris and has warm eyelash pigment.
        ax,ay,aw,ah = rect(white|iris)
        lower_options = support & ~iris & ~white & warm & (local_v < 148) & (local_sat > 50) & (rows >= iy+.73*ih)
        lower = largest(lower_options) if lower_options.any() else np.zeros_like(iris)
        if lower.any() and cv.boundingRect(lower.astype(np.uint8))[2] >= aw*.62:
            pass
        else:
            lower[:] = False
            lower_lash_absent.append(side)
        rim = support & ~iris & ~upper & ~white & ~lower
        white |= rim & (rows>=iy+round(ih*.10))
        if amber:
            # The semantic eye includes the fixed skin crease above the
            # lashes. Only the lash stroke and its antialiased rim descend.
            near_lash = cv.dilate(upper.astype(np.uint8),np.ones((3,3),np.uint8))>0
            upper |= rim & ~white & near_lash & (local_v<207)
        else:
            upper |= rim & ~white
        def full(m):
            result = np.zeros_like(alpha,bool)
            result[sl] = m
            return result
        def tagged(suffix,tags,m):
            add(side+"-"+suffix,tags+[side],full(m))
        # The eyelid fold may be a separate disconnected stroke. Keep its
        # antialiasing with the moving eye, away from the clean face plate.
        ex,ey,ew,eh = rect(support)
        guard = (xx>=l+ax+aw*.04) & (xx<l+ax+aw*.96) & (yy>=t+iy-ih*.65) & (yy<t+iy-ih*.12)
        pigment = ((hue<33)|(hue>=161)) & (value<230)
        # Only a separate warm stroke above the lid is an eyelid crease.
        # Face/hair boundary antialiasing must stay with its original surface.
        crease_core = guard & pigment & (sat>55) & masks["face"] & ~spread(full(upper),max(2,round(ih*.05)))
        fold = spread(largest(crease_core),2) & guard & pigment & masks["face"] & ~full(upper) if crease_core.any() else np.zeros_like(alpha,bool)
        if not amber and fold.any() and min(cv.boundingRect(fold.astype(np.uint8))[2:])>=2:
            add(side+"-fold",["eye","fold",side],fold)
            upper &= ~fold[sl]
            white &= ~fold[sl]
        tagged("upper",["eye","lash","upper"],upper)
        tagged("iris",["eye","iris"],iris)
        if lower.any():
            tagged("lower",["eye","lash","lower"],lower)
        tagged("white",["eye","white"],white)
        parts[-1]["under"] = full(iris)
        # Eyebrows are the light cool stroke surrounded by the warm skin base.
        brow_area = masks["face"] & (xx>=l) & (xx<r) & (yy>=t-round(ih*1.31)) & (yy<t-round(ih*.21))
        brow_ink = brow_area & (value<205) & (sat<88)
        inner = (xx>=l+round(iw*.42)) if side=="right" else (xx<r-round(iw*.42))
        brow_options = []
        for kernel in ((5,13),(4,7),(3,3)):
            connected = cv.morphologyEx((brow_ink & inner).astype(np.uint8),cv.MORPH_CLOSE,np.ones(kernel,np.uint8))
            n, labels, stats, _ = cv.connectedComponentsWithStats(connected)
            for i in range(1,n):
                if stats[i,2] >= iw*.52 and stats[i,2]>stats[i,3]*1.75:
                    brow_options.append((stats[i,2],labels==i))
        if not brow_options:
            # Some semantic models put a detached eyebrow in the eye
            # class. Use its component above this eye, never the lash.
            brow_area = (xx>=l) & (xx<r) & (yy>=t-round(ih*1.45)) & (yy<t)
            n, labels, stats, _ = cv.connectedComponentsWithStats((masks["eyes"] & brow_area).astype(np.uint8))
            brow_options = [(stats[i,2],labels==i) for i in range(1,n)
                            if stats[i,2]>=iw*.52 and stats[i,2]>stats[i,3]*1.75]
            if not brow_options:
                raise ValueError("找不到与脸部边缘分离的眉形")
            brow_area &= masks["eyes"] | masks["face"]
        brow = max(brow_options,key=lambda row:row[0])[1] & brow_area
        bx,by,bw,bh = rect(brow)
        brow = spread(brow,2) & brow_area & (xx>=bx-2) & (xx<bx+bw+2) & (yy>=by-2) & (yy<by+bh+2)
        if rect(brow)[2] < iw*.52:
            raise ValueError("眉毛缺少源像素证据")
        add(side+"-brow",["brow",side],brow)
        closed = np.zeros_like(source)
        closed[sl] = close_upper_lash(source[sl], upper, (ax,ay,aw,ah))
        add(side+"-closed",["eye","closed",side],closed[:,:,3]>0,hidden=True,pixels=closed)

    mouth = largest(masks["mouth"] & (sat>51) & ((hue < 23)|(hue>=166)))
    mx,my,mw,mh = rect(mouth)
    if not fw*.14 <= mw <= fw*.46 or mh < mw*.22:
        raise ValueError("嘴的独立开口边界不符合源图")
    contour, _ = cv.findContours(mouth.astype(np.uint8),cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE)
    aperture = np.zeros_like(alpha,np.uint8)
    cv.drawContours(aperture,contour,-1,1,cv.FILLED)
    aperture = aperture.astype(bool)
    lip = (masks["mouth"] | (spread(aperture,2) & (value<246))) & spread(aperture,4)
    rim = lip & ~(cv.erode(aperture.astype(np.uint8),np.ones((5,5),np.uint8)) > 0)
    add("mouth-upper",["mouth","line","upper","open"],rim & (yy < my+mh*.51))
    add("mouth-lower",["mouth","line","lower","open"],rim & (yy >= my+mh*.51))
    add("mouth-open",["mouth","open"],aperture)
    line_points = [(j,my+mh*(.47+.17*(1-((j-mx-mw*.5)/(mw*.5))**2))) for j in range(mx+3,mx+mw-3)]
    closed_mouth = stroke(mouth,line_points,np.percentile(rgb[rim & (yy<my+mh*.35)],35,axis=0),max(2,round(mw*.054)))
    add("mouth-closed",["mouth","closed"],closed_mouth[:,:,3]>0,hidden=True,pixels=closed_mouth)

    hair = masks["hair"]
    skin = (value>155) & ((hue<28)|(hue>=172))
    clean_skin = (value>229) & (sat>=17) & (sat<=67) & ((hue<23)|(hue>=176))
    # At the forehead and temples, recover face geometry only from warm
    # pixels; put sampled hair shadows back on the moving bangs.
    upper_face = yy < fy+fh*.65
    face = masks["face"] & (skin | ~upper_face)
    rejected = masks["face"] & upper_face & ~skin
    # The crown silhouette is fixed: only the hair in front of the
    # inferred scalp belongs to the moving fringe.
    crown_y = fy-fh*.21+fh*.21*np.minimum(1,((xx-cx)/(fw*.57))**2)
    # Do not move the long temple locks when revealing the forehead.
    forehead = (((xx-cx)/(fw*.51))**2+((yy-(fy+fh*.37))/(fh*.55))**2 < 1)
    cap = forehead & (yy>=crown_y) & (yy<fy+fh*.43)
    if amber_sides:
        # Long middle bangs extend between the eyes, below the usual cap.
        central_bangs = hair & (abs(xx-cx)<fw*.36) & (yy<fy+fh*.63)
        cap |= central_bangs & forehead
    headwear = masks.get("headwear")
    if headwear is not None:
        # The accessory and hair segmenters can both claim the narrow ink
        # edge of the fringe. Inside the scalp, keep that overlap with the
        # fringe if it touches unambiguous fringe and is at the accessory rim.
        shared = headwear & hair & cap
        fringe_rim = shared & spread(hair & cap & ~headwear, max(2,round(fw*.035)))
        fringe_rim &= spread(~headwear,max(2,round(fw*.023)))
        headwear = headwear & ~fringe_rim
        add("headwear",["head","accessory"],headwear)
    # Keep side locks in front of the face, separately from the fringe.
    locks = hair & ~cap & (yy<fy+fh*1.05) & ((abs(xx-cx)<fw*.87)|(yy<fy))
    shoulder_lock = np.zeros_like(hair)
    if np.median(sat[hair])>62:
        garment = masks["topwear"] | masks["handwear"]
        left = np.argmax(garment,axis=1)[:,None]
        right = w-1-np.argmax(garment[:,::-1],axis=1)[:,None]
        shoulder_top = rect(masks["handwear"])[1]
        # Hair between both garment flanks is in front of the jacket.
        # The upper taper joins it to the inner temple rather than the
        # wider sweep behind the sleeve.
        reach = np.clip((shoulder_top-yy)/max(1,shoulder_top-(fy+fh*1.02)),0,1)
        inner = (xx>left+fw*(.075+.44*reach)) & (xx<right-fw*(.075+.44*reach))
        bridge = (abs(xx-cx)<fw*(.54+.32*(1-reach))) & (yy<shoulder_top)
        shoulder_lock = hair & (inner | bridge) & (yy>=fy+fh*.99) & (yy<shoulder_top+fw*.99)
        locks |= shoulder_lock
    add("hair-temples",["hair","front","root"],locks | (rejected & ~forehead))
    if headwear is not None:
        parts[-1]["under"] = headwear & spread(locks, max(2, round(fw*.115)))
    edge_shadow = masks["face"] & spread(hair & cap,4) & ~clean_skin
    if amber_sides:
        # Shaded eyelid skin is warmer than the baseline face samples.
        # Do not promote it into the fringe merely because it is nearby.
        edge_shadow &= (sat>100) & (value<195)
    front = (hair & cap) | rejected | edge_shadow
    if amber_sides:
        # Keep the antialiased warm rim with the central bangs. The hair
        # segmentation occasionally ends inside the translucent edge.
        rim = spread(hair & cap,3) & forehead & ~clean_skin
        front |= rim & (sat>69) & (value<234)
    # A detached hair-mask island inside the brow may be part of the same
    # ink stroke. Recover its connected source pigment before making backings.
    # A component attached to the actual fringe is kept with the fringe.
    brow_reclaimed = np.zeros_like(front)
    for part in (p for p in parts if "brow" in p["tags"]):
        brow = part["mask"]
        bx,by,bw,bh = rect(brow)
        margin = max(3,round(bw*.50))
        tile = np.s_[max(0,by-bh):min(h,by+bh*2),max(0,bx-margin):min(w,bx+bw+margin)]
        ink = (value[tile]<155) & (rgb[tile][:,:,0].astype(int)-rgb[tile][:,:,2]<16) & (alpha[tile]>240)
        _,labels,stats,_ = cv.connectedComponentsWithStats(ink.astype(np.uint8))
        for i in np.unique(labels[brow[tile] & ink]):
            x,y,cw,ch,_ = stats[i]
            th,tw = ink.shape
            if x==0 or y==0 or x+cw==tw or y+ch==th or cw<ch*2 or ch>bh*1.35:
                continue
            stroke = labels==i
            if not np.any(stroke & front[tile] & ~brow[tile]):
                continue
            # Grow one antialiasing pixel around this isolated stroke.
            reclaim = spread(stroke,1)
            brow[tile] |= reclaim
            brow_reclaimed[tile] |= reclaim
    front &= ~brow_reclaimed
    locks &= ~brow_reclaimed
    next(p for p in parts if p["id"]=="hair-temples")["mask"] &= ~brow_reclaimed
    add("hair-front",["hair","front"],front)
    add("face",["face","skin"],(face | masks["eyes"] | masks["mouth"]) & ~brow_reclaimed)
    feature_mask = np.logical_or.reduce([p["mask"] for p in parts if not p["hidden"] and
                                        ("eye" in p["tags"] or "brow" in p["tags"] or "mouth" in p["tags"])])
    # Continue the covered forehead. Long temple locks cross the jaw and
    # collar, where a skin fill would become visible when the lock turns.
    # Keep backing inside the seam shared by the face and lock. A solid band
    # under the whole lock can emerge on the wrong side of its inked edge.
    v = (yy-fy)/fh
    taper = np.clip((v-.09)/.16,0,1)*np.clip((.78-v)/.18,0,1)
    skin_distance = cv.distanceTransform((~face).astype(np.uint8),cv.DIST_L2,3)
    temple_skin = locks & (skin_distance>0) & (skin_distance <= max(2,fw*.037)*taper)
    parts[-1]["under"] = feature_mask | (spread(front,4) & forehead) | temple_skin
    # The exposed neck belongs with the collar. Leaving it unclaimed lets
    # nearest-owner cleanup attach its upper edge to the rotating face.
    visible_neck = masks.get("neck",False) & ~masks["face"] & ~hair & (yy>=fy+fh*.85)
    add("bodice",["body","clothes"],masks["topwear"] | visible_neck)
    add("hair-back",["hair","back"],hair)
    # The front locks can trade overlap with the face at yaw extremes.
    # Keep a strip of sampled rear hair behind that shared boundary.
    temple_depth = max(3,round(fw*.15))
    temple_hair = locks | (front & (abs(xx-cx)>fw*.26))
    temple_seam = (face & spread(temple_hair,temple_depth)) | (temple_hair & spread(face,temple_depth))
    # Below the eye the collar owns the revealed area behind the jaw.
    temple_seam &= (yy>=fy+fh*.10) & (yy<fy+fh*.68)
    parts[-1]["under"] = (front & ~forehead) | temple_seam
    if amber_sides:
        # Fill behind the split at the bang root. The independent fringe can
        # pull away from the temple on yaw while both still cover it at rest.
        root_width = max(4, round(fw*.17))
        root_seam = front & hair & spread(locks,root_width) & (yy < fy+fh*.30)
        parts[-1]["under"] |= root_seam
    arm = largest(masks["handwear"] & (xx < cx))
    other = largest(masks["handwear"] & (xx >= cx))
    ax,ay,aw,ah = rect(arm)
    def anchor(f):
        row=round(ay+ah*f)
        cols=np.flatnonzero(arm[row])
        if len(cols) < fw*.04:
            raise ValueError("肩、肘、腕截面过窄")
        return [int(cols[np.argmin(abs(cols-np.median(cols)))]),row]
    # Find the wrist from the cuff/skin boundary rather than assuming a
    # position within every forearm. The elbow is halfway along the sleeve.
    hands = arm & (yy>ay+ah*.60) & (hue<30) & (sat>37) & (value>166)
    _, hand_top, _, _ = rect(largest(hands))
    wrist_fraction = (hand_top-ay)/ah
    if not .66 <= wrist_fraction <= .94:
        raise ValueError("找不到袖口接手腕的过渡")
    shoulder_fraction = .038 if shoulder_lock.any() else .08
    shoulder, elbow, wrist = anchor(shoulder_fraction), anchor(.48), anchor(min(.92,wrist_fraction+.03))
    # Near-edge wrists have no room for the outward sweep. Keep the elbow
    # beside the body and curl the forearm inward, above the jacket layer.
    inward = wrist[0] < .24*np.linalg.norm(np.subtract(wrist,shoulder))
    anchors = {"version":1,"shoulder":shoulder,"elbow":elbow,"wrist":wrist,
               "direction":-1 if inward else 1,"degrees":[7,145,12] if inward else [29,106,12]}
    # Keep the inked tips and shaded knuckles around the skin sample.
    hand_outline = largest(arm & (alpha>=240) & (yy>=anchors["wrist"][1]))
    anchors["fingertips"] = hand_landmarks(hand_outline,anchors["wrist"])
    upper_sleeve = arm & (yy<ay+ah*.53) & (alpha>=240)
    cloth_tone = float(np.median(value[upper_sleeve]))
    # A hard semantic mask may eat a sliver of the bright lining or hair
    # just outside the inked boundary of a dark sleeve. Keep that sliver
    # with the static neighbor, including pixels left by the near-mask pass.
    # Do not touch the connected cuff, the hand or highlights inside the cloth.
    if cloth_tone<105:
        cuff_seed = arm & (value>145) & (yy>ay+ah*.57) & (yy<hand_top-2)
        cuff = spread(largest(cuff_seed),max(2,round(fw*.02)))
        stray = (value>108) & (yy<hand_top) & ~cuff & ~spread(hands,2)
        trim = arm & stray & ~claimed & (alpha>0)
        for owner in ("bodice","hair-back"):
            part = next(p for p in parts if p["id"]==owner)
            adjacent = trim & (spread(masks["topwear"],5) if owner=="bodice" else
                               (spread(hair,4) | ((value>175) & (sat<62) & (xx < cx-fw*.60))))
            part["mask"] |= adjacent
            claimed |= adjacent
            trim &= ~adjacent
        edge_width=max(4,round(fw*.023))
        edge=spread(~arm,edge_width) & arm
        detached=trim & edge & (value>max(110,cloth_tone+53)) & (sat<85)
        axis_x,axis_y=zip(*(anchors[k] for k in ("shoulder","elbow","wrist")))
        local_axis=np.interp(yy[:,0],axis_y,axis_x)[:,None]
        inner=(xx-local_axis)*(cx-local_axis)>0
        for owner,side in (("bodice",inner),("hair-back",~inner)):
            adjacent=detached & side
            next(p for p in parts if p["id"]==owner)["mask"] |= adjacent
            claimed |= adjacent
    arm = largest(arm & ~claimed)
    add("wave-sleeve",["arm","sleeve","gesture","wave","continuous"],arm,rig={"continuousWave":anchors})
    shx,shy = anchors["shoulder"]
    row = np.flatnonzero(arm[shy])
    if row.size<4:
        raise ValueError("肩袖在肩轴处没有连通的可见袖布")
    radius = max(4,round((row[-1]-row[0])*.52))
    # Round shoulder cap, sampled from opaque sleeve fabric. Never clone
    # the patterned cuff or stretch the black line on the source boundary.
    cap_y = ay-radius*.30
    cap_x = anchor(min(.035,shoulder_fraction*.62))[0] if shoulder_lock.any() else anchor(.035)[0]
    cap_t = np.clip((yy-cap_y)/(shy-cap_y),0,1)
    cap = (abs(xx-(cap_x+(shx-cap_x)*cap_t))<radius*np.sin(cap_t*np.pi/2)) & (yy>=cap_y) & (yy<=shy+radius*.28)
    parts[-1]["under"] = cap & (hair | masks["topwear"])
    shoulder_fabric = arm & (yy>=shy) & (yy<shy+radius*2) & (abs(xx-shx)<radius)
    if cloth_tone<105:
        sleeve_interior = shoulder_fabric & (value<104)
    else:
        shoulder_fabric &= (alpha>=240) & ~spread(~arm,2)
        if not shoulder_fabric.any():
            raise ValueError("肩部缺少可用于修补遮挡的原袖布")
        low, high = np.percentile(value[shoulder_fabric],[25,85])
        sleeve_interior = shoulder_fabric & (value>=low) & (value<=high)
    if not sleeve_interior.any():
        raise ValueError("肩部缺少可用于修补遮挡的原袖布")
    parts[-1]["sleeveSample"] = (sleeve_interior,shx,shy,cap_x,cap_y,radius)
    add("other-sleeve",["arm","sleeve"],other)
    for name in ("bottomwear","legwear","footwear"):
        if name in masks:
            add(name,["body",name],masks[name])
    # Keep the neck backing within the source collar opening. A broad
    # forehead-colored plate shows through beside the jaw when it turns.
    neck_window = (abs(xx-cx)<fw*.25) & (yy>=fy+fh*.86) & (yy<fy+fh*1.10)
    neck_skin = neck_window & (masks["topwear"] | visible_neck) & ~face & opaque & skin & (sat>28)
    if np.count_nonzero(neck_skin) >= max(8,round(fw*.05)):
        _, neck_cols = np.nonzero(neck_skin)
        left, right = np.percentile(neck_cols,[5,95])
        neck_x = (left+right)*.5
        neck_width = np.clip((right-left)*.33,fw*.07,fw*.125)
        pigment = np.median(rgb[neck_skin],axis=0)
    else:
        neck_x, neck_width = cx, fw*.10
        chin = face & clean_skin & (yy>fy+fh*.68)
        samples = chin if chin.any() else face & clean_skin
        pigment = np.median(rgb[samples if samples.any() else face],axis=0)
    neck_radius = ((xx-neck_x)/neck_width)**2+((yy-(fy+fh*.96))/(fh*.11))**2
    neck = neck_radius < 1
    neck &= opaque & claimed
    add("neck",["neck"],neck,hidden=True,pixels=None)
    parts[-1].update(hidden=False, latent=True, color=pigment,
                     backingAlpha=np.round(255*np.clip((1-neck_radius)/.62,0,1)).astype(np.uint8))
    add("remaining",["body","edge"],alpha>0) if (~claimed & (alpha>0)).any() else None

    # Stable back-to-front order. Assign residual source pixels to the
    # nearest movable owner, rather than freezing antialiasing at seams.
    owners = [p for p in parts if not p["hidden"] and not p.get("latent") and p["id"]!="remaining"]
    residual = next((p["mask"] for p in parts if p["id"]=="remaining"),None)
    if residual is not None:
        owner_map = np.zeros_like(alpha,np.uint16)
        for i,p in enumerate(owners,1):
            owner_map[p["mask"]]=i
        near = nearest(owner_map!=0)
        index = owner_map[tuple(near)]
        for i,p in enumerate(owners,1):
            p["mask"] |= residual & (index==i)
        parts = [p for p in parts if p["id"]!="remaining"]
    # Neutral dark antialiasing can lie between the warm lash and cool iris.
    # Nearest-owner fill alone can leave those pixels in the sclera, where
    # they remain at their old height while the upper lid closes.
    face_plate = next(p for p in parts if p["id"]=="face")
    fringe = next(p for p in parts if p["id"]=="hair-front")
    # On cool, dark bangs the semantic cut can carry an opaque ribbon of
    # forehead along each lock, and leave small pieces of cool ink on the
    # face. Yaw exposes both mistakes. Split by the actual edge pigment;
    # the color of each reassigned pixel at rest is unchanged.
    cool_ink = (rgb[:,:,2].astype(int)-rgb[:,:,0].astype(int)>8) & (value<183) & opaque
    fringe_core = fringe["mask"] & cool_ink
    fringe_edge_pixels = 0
    if np.count_nonzero(fringe_core) > np.count_nonzero(fringe["mask"])*.55:
        above_lids = yy<fy+fh*.57
        warm_edge = (fringe["mask"] & above_lids & clean_skin & (rgb[:,:,1]>184) &
                     spread(face_plate["mask"],max(3,round(fw*.04))))
        stray_ink = (face_plate["mask"] & above_lids & cool_ink &
                     spread(fringe_core,max(3,round(fw*.036))))
        fringe["mask"] = (fringe["mask"] & ~warm_edge) | stray_ink
        face_plate["mask"] = (face_plate["mask"] & ~stray_ink) | warm_edge
        face_plate["under"] |= stray_ink | (spread(fringe["mask"],max(4,round(fw*.035))) & forehead)
        fringe_edge_pixels = int(np.count_nonzero(warm_edge | stray_ink))
    green = rgb[:,:,1]
    green_dip = cv.morphologyEx(green,cv.MORPH_CLOSE,np.ones((5,5),np.uint8))-green
    for side in ("left", "right"):
        eye = {p["id"]:p for p in parts if "eye" in p["tags"] and side in p["tags"]}
        upper, white, iris = (eye[f"{side}-{name}"]["mask"] for name in ("upper","white","iris"))
        ix,iy,iw,ih = rect(iris)
        # The semantic eye mask ends inside the source antialiasing. Keep
        # the rest of that ink with its moving part instead of the face.
        radius = max(2,round(ih*.18))
        # Rejected dark skin pixels can also have been assigned to the
        # fringe. Recover those inside the face, excluding actual hair.
        stray = fringe["mask"] & ~hair & ~spread(hair,2)
        pigment = (face_plate["mask"] | stray) & masks["face"] & opaque & ((value<250) | (green_dip>3))
        if side in amber_sides:
            # Keep red fringe and the existing lid shadow on their original
            # surfaces, including pixels in the eye model's wide mask.
            pigment &= (value<223) & ~hair
            outer_iris = white & (value<165) & spread(iris,4)
            iris |= outer_iris
            white &= ~outer_iris
        lash_fringe = pigment & spread(upper,radius) & (yy<iy+ih*.42)
        aperture_fringe = pigment & spread(white | iris,max(2,round(ih*.10))) & ~lash_fringe
        fold = eye.get(f"{side}-fold")
        crease_fringe = np.zeros_like(alpha,bool)
        if fold is not None:
            crease_fringe = pigment & spread(fold["mask"],radius) & (yy<iy-ih*.06)
            fold["mask"] |= crease_fringe
        moved = lash_fringe | aperture_fringe | crease_fringe
        fringe["mask"] &= ~moved
        face_plate["mask"] &= ~moved
        face_plate["under"] |= moved
        feature_mask |= moved
        upper |= lash_fringe & ~crease_fringe
        white |= aperture_fringe & ~crease_fringe
        ink = white & (value<173) & (yy<iy+ih*.34) & spread(upper,max(2,round(ih*.13)))
        white &= ~ink
        upper |= ink
        if fold is not None:
            core = largest(upper & ((hue<30)|(hue>=160)) & (value<185) & (sat>44))
            above = yy < np.argmax(core,axis=0)[None,:]
            shadow = upper & above & ~spread(core,max(2,round(ih*.065)))
            upper &= ~shadow
            fold["mask"] |= shadow
        if side in amber_sides:
            nearby = spread(upper,3)
            lingering_lash = (face_plate["mask"] | fringe["mask"]) & ~hair & nearby & (value<206)
            fringe["mask"] &= ~lingering_lash
            face_plate["mask"] &= ~lingering_lash
            face_plate["under"] |= lingering_lash
            feature_mask |= lingering_lash
            upper |= lingering_lash
            # Dark iris outlines touch the eyelash near its two corners.
            # Keep those vertical edges on the iris, not the descending ink.
            iris_wall = upper & spread(iris,5) & (yy>iy+ih*.12) & (xx>=ix-4) & (xx<ix+iw+4)
            iris |= iris_wall
            upper &= ~iris_wall
            ux,uy,uw,uh = rect(upper)
            # Keep the original lid shading in neutral, then expose a
            # continuous skin plate as the upper lid descends.
            lid_area = (((xx-(ux+uw*.5))/(uw*.59))**2+
                        ((yy-(iy-ih*.21))/(ih*.63))**2<1)
            ink_core = upper & (value<137)
            light_rim = upper & ((value>174) | ~spread(ink_core,1))
            lid = (light_rim | ((face_plate["mask"] | fringe["mask"]) & lid_area)) & ~hair & opaque
            if lid.any():
                upper &= ~lid
                fringe["mask"] &= ~lid
                face_plate["mask"] &= ~lid
                face_plate["under"] |= lid
                feature_mask |= lid
                parts.append(dict(id=f"{side}-fold",tags=["eye","fold",side],mask=lid,
                                  hidden=False,pixels=None,rig=None))
        closed = eye[f"{side}-closed"]
        x,y,a,b = rect(upper | white | iris | closed["mask"])
        tile = np.s_[y:y+b,x:x+a]
        closed["pixels"][:] = 0
        closed["pixels"][tile] = close_upper_lash(source[tile],upper[tile],rect((white|iris)[tile]))
        closed["mask"] = closed["pixels"][:,:,3]>0
    # A closed-eye/mouth variant goes in front of the face, behind the bangs.
    rear = next(p for p in parts if p["id"]=="hair-back")
    sleeve = next(p for p in parts if p["id"]=="wave-sleeve")
    bodice = next(p for p in parts if p["id"]=="bodice")
    temples = next(p for p in parts if p["id"]=="hair-temples")
    garment_masks = [p["mask"] for p in parts if p["id"] in ("bodice","bottomwear")]
    return_garment_shadows(rear["mask"],garment_masks,value,shy,anchors["wrist"][1],fw)
    # The independently moving locks need overlapping rear hair where the
    # two hair pieces meet, including the lower shoulder ends.
    seam_depth = max(3,round(fw*.20))
    rear["lockOverlap"] = temples["mask"] & hair & spread(rear["mask"],seam_depth)
    rear["under"] |= rear["lockOverlap"]
    collar_zone = (yy>fy+fh*.61) & (yy<fy+fh*1.13) & (abs(xx-cx)<fw*.65)
    neckline = (yy>fy+fh*.74) & (yy<fy+fh*1.13) & (abs(xx-cx)<fw*.51)
    # Continue the painted collar backing under the moving jaw. A collar
    # extension under the locks shows a gray bar when the hair moves aside.
    # Only opaque foreground can hide new pixels in the neutral composite.
    collar = bodice["mask"] & collar_zone & opaque & (value>125) & (value<225) & (sat<75)
    if np.count_nonzero(collar)>fw:
        reach = max(3,round(fw*.20))
        bodice["under"] = neckline & spread(collar,reach) & face
        bodice["collarSample"] = collar
        # Both visible edges can move away from the shoulder junction. Extend
        # the rear volume behind both owners, so it cannot cross in front of
        # the lock as a strip of collar color.
        near_collar = spread(collar,max(3,round(fw*.33)))
        near_hair = spread(rear["mask"] | temples["mask"],max(3,round(fw*.22)))
        shoulder_arc = ((yy-(fy+fh*.96))/(fh*.27))**2+((xx-cx)/(fw*1.12))**2 < 1
        rear["shoulderOverlap"] = near_collar & near_hair & shoulder_arc
        rear["under"] |= rear["shoulderOverlap"]
    if shoulder_lock.any():
        cloth = bodice["mask"] & opaque & (value<117)
        reach = max(5,round(fw*.27))
        bodice["jacketSample"] = cloth
        bodice["jacketUnder"] = shoulder_lock & spread(cloth,reach) & (yy>=shy-fw*.29)
        bodice["under"] = bodice.get("under",False) | bodice["jacketUnder"]
    continuation = sleeve_hair_continuation(rear["mask"],sleeve["mask"],opaque,rgb,sat,value,anchors,fw)
    if continuation:
        rear["strandFill"],rear["strandPigment"],rear["strandTaper"],rim = continuation
        rear["mask"] &= ~rim
        sleeve["mask"] |= rim
        rear["under"] |= rear["strandFill"]
    rank = {"footwear":1,"legwear":2,"bottomwear":3,"other-sleeve":4,
            "hair-back":5,"wave-sleeve":6.5 if inward else 5.5,"bodice":6,"neck":7,"face":8,"mouth-open":10,"hair-front":19,"hair-temples":20,"headwear":21}
    parts.sort(key=lambda p:rank.get(p["id"],9 if p["id"].endswith("-white") else 11))
    # Keep both resting hands, the waist and a small margin below the cuffs.
    # Cut the actual model canvas so a fresh Leaf import has the same default.
    crop_bottom = min(h,max(rect(p["mask"])[1]+rect(p["mask"])[3]
                           for p in (sleeve,next(p for p in parts if p["id"]=="other-sleeve")))
                      +round(fh*.09)) if framing=="half_body" else h
    # Mark the owner pixels hiding real underpaint before writing either
    # layer, so a 254/255 dither does not cut holes in the new texture.
    underlaps = np.zeros_like(alpha,bool)
    for p in parts:
        underlaps |= p.get("under",False)
        if p.get("latent"):
            underlaps |= p["mask"]
    # Compute which opaque owners are in front to keep additions invisible in neutral.
    covered = np.zeros_like(alpha,bool)
    entries = []
    for p in reversed(parts):
        name,m,hidden = p["id"],p["mask"],p["hidden"]
        origin = "generated" if hidden else "segmented"
        if hidden:
            data = p["pixels"]
        else:
            data = np.zeros_like(source)
            if p.get("latent"):
                m &= covered
                data[m,:3] = p["color"]
                data[m,3] = p["backingAlpha"][m]
                origin = "inpainted"
            else:
                data[m] = source[m]
                data[m & opaque & underlaps,3]=255
                fill = p.get("under",False) & covered & ~m
                if np.any(fill):
                    # Inpaint within a bounded tile: feature holes do not
                    # sample hair or eye pigment from another layer.
                    x,y,a,b = rect(m | fill)
                    tile = np.s_[y:y+b,x:x+a]
                    if name == "face":
                        safe = m[tile] & clean_skin[tile] & ~spread(feature_mask,5)[tile]
                        if amber_sides:
                            warm_skin = skin[tile] & (value[tile]>226) & (sat[tile]<89)
                            safe = m[tile] & warm_skin & ~spread(feature_mask,3)[tile]
                        near = nearest(safe)
                        initial = source[tile][tuple(near)][:,:,:3].copy()
                        # Smooth the inferred skin only. Nearest clean skin
                        # preserves the local complexion; smoothing removes
                        # hard extrapolation bands at the two temples.
                        sigma=max(3,fw*.043)
                        if amber_sides:
                            sigma=max(3,fw*.021)
                        weights=cv.GaussianBlur(safe.astype(np.float32),(0,0),sigma)
                        tone=cv.GaussianBlur(source[tile][:,:,:3].astype(np.float32)*safe[:,:,None],(0,0),sigma)
                        soft=cv.GaussianBlur(initial,(0,0),sigma)
                        mix=np.clip(weights*3,0,1)[:,:,None]
                        q=soft*(1-mix)+tone/np.maximum(weights[:,:,None],1e-6)*mix
                        data[tile][fill[tile],:3] = q[fill[tile]]
                    elif name.endswith("-white"):
                        safe = m[tile] & (sat[tile]<42) & (value[tile]>167)
                        near = nearest(safe)
                        data[tile][fill[tile],:3]=source[tile][tuple(near)][fill[tile],:3]
                    elif name == "wave-sleeve":
                        safe,sx,sy,cx0,cy0,radius=p["sleeveSample"]
                        x0,y0,ww,hh=rect(safe)
                        source_tile=np.s_[y0:y0+hh,x0:x0+ww]
                        near=nearest(safe[source_tile])
                        cloth=cv.GaussianBlur(rgb[source_tile][near],(0,0),max(2,radius*.075))
                        yq,xq=np.nonzero(fill)
                        d=np.clip((sy-yq)/max(1,sy-cy0),0,1)
                        cross=np.clip((xq-(sx+(cx0-sx)*d))/radius,-1,1)
                        sample_y=np.clip(sy+radius*(.16+.83*d)-y0,0,hh-1).astype(int)
                        sample_x=np.clip(sx-radius*.15*d+cross*radius*.79-x0,0,ww-1).astype(int)
                        tone=cloth[sample_y,sample_x].astype(float)
                        tone-=((cross**2)*8+d*3)[:,None]
                        data[fill,:3]=np.clip(tone,0,255)
                    elif name == "bodice":
                        jacket = fill[tile] & p["jacketUnder"][tile] if "jacketUnder" in p else np.zeros_like(fill[tile])
                        for region, sample in ((fill[tile] & ~jacket,"collarSample"),(jacket,"jacketSample")):
                            if region.any():
                                near = nearest(p[sample][tile])
                                backing = cv.GaussianBlur(rgb[tile][near],(0,0),max(2,fw*.023))
                                data[tile][region,:3] = backing[region]
                    elif name in ("hair-back", "hair-temples"):
                        # The under-fringe volume needs a neutral hair tone,
                        # without reprinting the moving fringe's ink lines.
                        strands = m[tile] & hair[tile]
                        if strands.any() and np.median(sat[tile][strands])>62:
                            low, high = np.percentile(value[tile][strands],[32,82])
                            safe = strands & (sat[tile]>48) & (value[tile]>=low) & (value[tile]<=high)
                        else:
                            safe = m[tile] & (value[tile]>231) & (sat[tile]<31)
                            if not safe.any():
                                safe = m[tile] & (value[tile]>192) & (sat[tile]<42)
                        if not safe.any():
                            safe = strands if strands.any() else m[tile]
                        near=nearest(safe)
                        q=cv.GaussianBlur(source[tile][tuple(near)][:,:,:3],(0,0),max(2,fw*.04))
                        data[tile][fill[tile],:3]=q[fill[tile]]
                        if name == "hair-back":
                            overlap = fill & p["lockOverlap"]
                            # Follow the existing strand shading across the
                            # cut. Soften duplicated ink behind the front lock.
                            tone = cv.GaussianBlur(rgb[tile],(0,0),max(1,fw*.009))
                            if not shoulder_lock.any():
                                data[tile][overlap[tile],:3]=tone[overlap[tile]]
                            if "shoulderOverlap" in p:
                                shoulder = fill[tile] & p["shoulderOverlap"][tile]
                                # This layer is rear hair. The collar limits
                                # the support region but never supplies pigment.
                                locks = (m[tile] | temples["mask"][tile]) & hair[tile]
                                if locks.any() and np.median(value[tile][locks]) < 128:
                                    low, high = np.percentile(value[tile][locks], [25, 75])
                                    sample = locks & (value[tile]>=low) & (value[tile]<=high)
                                else:
                                    sample = safe | (temples["mask"][tile] & hair[tile] &
                                                     (sat[tile]<48) & (value[tile]>200))
                                tone = cv.GaussianBlur(rgb[tile][nearest(sample)],(0,0),max(2,fw*.055))
                                data[tile][shoulder,:3]=tone[shoulder]
                    else:
                        near=nearest(m[tile])
                        data[tile][fill[tile],:3]=source[tile][tuple(near)][fill[tile],:3]
                    data[fill,3]=255
                    if name == "hair-back" and "shoulderOverlap" in p:
                        extension = fill[tile] & p["shoulderOverlap"][tile] & ~p["lockOverlap"][tile]
                        distance = cv.distanceTransform((m[tile] | extension).astype(np.uint8),cv.DIST_L2,3)
                        data[tile][extension,3] = (255*np.minimum(1,distance[extension]/max(2,fw*.024))).astype(np.uint8)
                    origin="inpainted"
                if name == "hair-back" and "strandFill" in p:
                    strand = p["strandFill"]
                    if np.any(strand & ~fill):
                        raise ValueError("袖后发束补绘在中立位超出遮挡")
                    data[strand,:3] = p["strandPigment"]
                    # Feather the join within the opaque sleeve overlap.
                    # Coloring its translucent edge would change the source.
                    coverage = cv.GaussianBlur((m | strand).astype(np.float32),(5,5),.85)
                    data[strand,3] = np.round(coverage[strand]*p["strandTaper"]*255).astype(np.uint8)
                covered |= m & opaque
        data = data[:crop_bottom]
        if not data[:,:,3].any():
            continue
        x,y,a,b = rect(data[:,:,3]>0)
        Image.fromarray(data[y:y+b,x:x+a]).save(output/(name+".png"))
        entry={"id":name,"name":name,"tags":p["tags"],"rect":{"left":x,"top":y,"width":a,"height":b},
               "visible":not hidden,"origin":origin}
        if hidden:
            entry["variant"]={"type":"toggle","parameter":"Param"+name.title().replace("-","")}
        if p["rig"]:
            entry["rigging"]=p["rig"]
        entries.append(entry)
    folds = elbow_fabric(source, sleeve["mask"], anchors)
    if folds is not None:
        x,y,a,b = rect(folds[:,:,3]>0)
        Image.fromarray(folds[y:y+b,x:x+a]).save(output/"wave-elbow-fold.png")
        entries.insert(next(i for i,p in enumerate(entries) if p["id"]=="wave-sleeve"),{
            "id":"wave-elbow-fold","name":"Elbow fabric compression","tags":["arm","sleeve","gesture","wave","elbow-fold"],
            "rect":{"left":x,"top":y,"width":a,"height":b},"visible":True,"opacity":0,"origin":"generated"})
    canvas = {"width":w,"height":crop_bottom}
    entries.reverse()
    collar_repairs = repair_collar(output, entries, canvas)
    brow_backprint_pixels = remove_brow_backprint(output, entries)
    print(json.dumps({"canvas":canvas,"parts":entries,"noLowerLash":lower_lash_absent,"collarRepairs":collar_repairs,
                      "browBackprintPixels":brow_backprint_pixels,"fringeEdgePixels":fringe_edge_pixels,
                      "anchors":anchors,"regions":regions,
                      "sleeveHairUnderpaintPixels":0 if continuation is None else int(np.count_nonzero(continuation[0]))}))


if __name__ == "__main__":
    main(Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3],*map(Path,sys.argv[4:]))
