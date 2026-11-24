"""Separate observable facial features from a confirmed eye box in source-image coordinates.

An open eye with enough chromatic contrast yields separate visible iris, eyelid
strokes and a sclera filled between its observed edges. Absent or ambiguous
anatomy is omitted. The caller paints the union of eraseMask in the source
layer once and draws these transparent layers in this order.
"""
import math
import cv2
import numpy as np
from PIL import Image


def remove_brow_backprint(parts_dir, parts):
    """Remove brow-colored ink from the opaque skin directly behind a movable brow."""
    face = next(p for p in parts if p["id"] == "face")
    file = parts_dir / "face.png"
    rgba = np.array(Image.open(file).convert("RGBA"))
    fx, fy = face["rect"]["left"], face["rect"]["top"]
    changed = 0
    for brow in (p for p in parts if "brow" in p["tags"]):
        brow_file = parts_dir / (brow["id"] + ".png")
        ink = np.array(Image.open(brow_file).convert("RGBA"))
        x, y = brow["rect"]["left"] - fx, brow["rect"]["top"] - fy
        h, w = ink.shape[:2]
        if x < 0 or y < 0 or x + w > rgba.shape[1] or y + h > rgba.shape[0]:
            continue
        # A semantic mask can cut across the original brow, leaving a
        # disconnected portion on the skin. Search the adjoining stroke band
        # and use color to preserve the warmer eyelid shadow.
        radius = max(2, round(h * .44))
        x0, y0 = max(0, x-radius), max(0, y-radius)
        x1, y1 = min(rgba.shape[1], x+w+radius), min(rgba.shape[0], y+h+radius)
        front = np.zeros((y1-y0, x1-x0, 4), np.uint8)
        front[y-y0:y-y0+h, x-x0:x-x0+w] = ink
        support = ((front[:,:,3] > 32) & (front[:,:,:3].max(2) < 203)).astype(np.uint8)
        support = cv2.dilate(support, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1)))
        skin = rgba[y0:y1, x0:x1]
        top = max(0, y - max(5, h))
        pad = rgba[top:y, x:x+w]
        clean = (pad[:,:,3] == 255) & (pad[:,:,0] > 212) & (pad[:,:,0].astype(int) - pad[:,:,2] > 16)
        if np.count_nonzero(clean) < 8:
            continue
        color = np.median(pad[clean,:3],axis=0).astype(np.uint8)
        red = skin[:,:,0].astype(np.int16)
        blue = skin[:,:,2].astype(np.int16)
        mask = (support != 0) & (skin[:,:,3] == 255) & ((red < 192) | ((red < int(color[0])-14) & (red-blue < 41)))
        if not mask.any():
            continue
        # Transfer the neutral stroke pixels to its moving owner. Retain the
        # exact source composite even when the old brow PNG missed the fringe.
        alpha = front[mask,3:4].astype(np.int32)
        front[mask,:3] = (front[mask,:3]*alpha + skin[mask,:3]*(255-alpha) + 127)//255
        front[mask,3] = 255
        skin[mask,:3] = color
        Image.fromarray(front).save(brow_file)
        brow["rect"] = dict(left=fx+x0, top=fy+y0, width=x1-x0, height=y1-y0)
        changed += int(mask.sum())
    if changed:
        Image.fromarray(rgba).save(file)
    return changed


def _bounds(roi, width, height):
    if (not isinstance(roi, list) or len(roi) != 4 or
            not all(isinstance(v, (float, int)) and math.isfinite(v) and 0 <= v <= 1 for v in roi)):
        return None
    # Normalized coordinates may represent an integer boundary within a few
    # floating-point ulps. Keep the same support after translating the image.
    x, y = math.floor(round(roi[0]*width,8)), math.floor(round(roi[1]*height,8))
    w, h = math.ceil(round(roi[2]*width,8))-x, math.ceil(round(roi[3]*height,8))-y
    return (x, y, w, h) if min(w, h) >= 5 and w*h <= 350000 else None


def _components(mask):
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
    for i in range(1, n):
        x, y, w, h, area = map(int, stats[i])
        yield labels == i, (x, y, w, h, area), centroids[i]


def _part(semantic, image, local_mask, x, y, note, origin='segmented', visible_pixels=None):
    xx, yy, w, h = cv2.boundingRect(local_mask.astype(np.uint8))
    rgba = image[yy:yy+h, xx:xx+w].copy()
    alpha = local_mask[yy:yy+h, xx:xx+w]
    rgba[:, :, 3] = np.where(alpha, rgba[:, :, 3], 0)
    return dict(semantic=semantic, rgba=rgba, x=x+xx, y=y+yy, origin=origin,
                visible=True, erase=True,
                eraseMask=(visible_pixels if visible_pixels is not None else local_mask)[yy:yy+h, xx:xx+w],
                note=note)


def _eyeline(rgb, iris, upper):
    """Trace a continuous dark stroke along the iris edge; exclude pigmented iris and bright skin."""
    h, w = iris.shape
    ix, iy, iw, ih = cv2.boundingRect(iris.astype(np.uint8))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(float)
    saturation = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)[:, :, 1].astype(float)
    ty = iy if upper else iy + ih
    ry = max(2, round(ih*.42))
    rows, cols = np.indices(iris.shape)
    # The line can run toward either corner of the model's observed eye box.
    outside = np.maximum.reduce([ix-cols, cols-(ix+iw-1), np.zeros_like(cols)])
    target = ty + (1 if upper else -1)*np.clip(outside/max(1, iw), 0, .6)*ih*.6
    target -= (1 if upper else 0)
    outer_rows = np.clip(rows+(-ry if upper else ry), 0, h-1)
    exterior = gray[outer_rows, cols]
    score = .58*(exterior-gray) + .42*(235-gray) - .22*saturation - 11*np.abs(rows-target)/ry
    allowed = ((np.abs(rows-target) <= ry) & ~iris & (gray < 208) &
               (exterior-gray > (4 if upper else 9)) & (saturation < 110))
    # Short, isolated shadows are not enough to declare a lid.
    candidates = (score > (30 if upper else 25)) & allowed
    mid = ix + iw*.5
    acceptable = []
    for component, (x, y, cw, ch, area), (cx, cy) in _components(candidates):
        if (cw < iw*(.68 if upper else .47) or abs(cx-mid) > iw*.65 or
                ch > max(4, ih*(.95 if upper else .65)) or area > .32*h*w):
            continue
        acceptable.append((cw/(1+abs(cx-mid)/iw), component))
    return max(acceptable, key=lambda row: row[0])[1] if acceptable else None


def _eye(source, box, side):
    x, y, w, h = box
    if not .75 <= w/h <= 6:
        return None
    tile = source[y:y+h, x:x+w]
    rgb = tile[:, :, :3].copy()
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    sat, value = hsv[:, :, 1], hsv[:, :, 2]
    threshold = max(62., np.percentile(sat, 50)+28., np.percentile(sat, 95)*.43)
    opaque = tile[:, :, 3] > 200
    choices = []
    for mask, (ix, iy, iw, ih, area), (cx, cy) in _components((sat >= threshold) & opaque):
        if (area < max(7, w*h*.045) or not .15*w <= iw <= .86*w or
                not .25*h <= ih <= .95*h or not .46 <= iw/ih <= 2.2 or
                abs(cx-(w-1)/2) > .23*w or abs(cy-(h-1)/2) > .31*h):
            continue
        choices.append((area, mask))
    choices.sort(key=lambda item: -item[0])
    if not choices or len(choices)>1 and choices[1][0]>.42*choices[0][0]:
        return None
    # Include highlights enclosed by the colored region, but do not invent the hidden iris.
    iris = np.zeros((h, w), np.uint8)
    contours, _ = cv2.findContours(choices[0][1].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(iris, contours, -1, 1, cv2.FILLED)
    iris = iris.astype(bool)
    ix, iy, iw, ih = cv2.boundingRect(iris.astype(np.uint8))
    # Include pale reflected colors along the iris perimeter. Bright gold or
    # silver-blue rims must move with the iris instead of sticking to the white.
    rim_zone=cv2.dilate(iris.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    hue=hsv[:,:,0].astype(float)
    core_hue=float(np.median(hue[choices[0][1]]))
    hue_delta=np.abs((hue-core_hue+90)%180-90)
    edge_color=rim_zone & (hue_delta<18) & (sat>50) & opaque
    upper = _eyeline(rgb, iris, True)
    if upper is None:
        return None
    lower = _eyeline(rgb, iris, False)
    iris |= edge_color
    upper &= opaque & ~iris
    if lower is not None:
        lower &= opaque & ~upper & ~iris
        if not lower.any():
            lower=None
    # Confirm that the iris is bounded by real *neutral* sclera on both sides.
    # A skin patch, coloured ornament, or hair highlight inside an imprecise box fails here.
    columns = np.arange(w)
    warmth = rgb[:,:,0].astype(float) - np.minimum(rgb[:,:,1],rgb[:,:,2])
    white = (sat < 22) & (warmth < 10) & (value > 173) & opaque & ~iris & ~upper
    if lower is not None:
        white &= ~lower
    rows = np.arange(h)
    white &= ((rows >= iy) & (rows < iy+ih))[:, None]
    sides = []
    for left in (True, False):
        flank = (columns < ix+iw*.22) if left else (columns > ix+iw*.78)
        flank &= (columns >= ix-iw*.85) if left else (columns < ix+iw*1.85)
        viable = []
        for mask, (_, _, ww, hh, area), (cx, cy) in _components(white & flank):
            if area >= max(4, iw*ih*.033) and hh >= ih*.25:
                viable.append((area/(1+abs(cx-(ix if left else ix+iw-1))/iw), mask))
        if not viable:
            return None
        sides.append(max(viable, key=lambda item: item[0])[1])
    middle_rows = np.where(sides[0].any(1) & sides[1].any(1))[0]
    if len(middle_rows) < max(2, ih*.23):
        return None
    # The convex aperture only spans verified source pixels. The neutral bridge
    # behind the iris is the only newly colored part of the white raster.
    aperture = np.zeros((h, w), np.uint8)
    points = cv2.findNonZero((sides[0]|sides[1]|iris).astype(np.uint8))
    cv2.fillConvexPoly(aperture, cv2.convexHull(points), 1)
    aperture = aperture.astype(bool)&opaque&~upper
    if lower is not None:
        aperture &= ~lower
    # Anti-aliased iris rims retain their original tone and travel with the iris.
    rim_zone = cv2.dilate(iris.astype(np.uint8), np.ones((3,3), np.uint8)).astype(bool)
    iris |= rim_zone & aperture & (sat > 22) & ((value < 235) | (hue_delta < 18))
    front = iris & aperture
    visible_white = aperture & ~front
    white_pixels = tile.copy()
    for row in np.where(front.any(1))[0]:
        ref_row = middle_rows[np.abs(middle_rows-row).argmin()]
        samples = [np.median(rgb[ref_row, mask[ref_row]], axis=0) for mask in sides]
        xx = np.where(front[row])[0]
        f = np.clip((xx-ix)/max(1, iw-1), 0, 1)[:,None]
        white_pixels[row,xx,:3] = np.rint(samples[0]*(1-f)+samples[1]*f).astype(np.uint8)
    tag = lambda name: f'{name}:{side}'
    made = [_part(tag('eye:white'), white_pixels, aperture, x, y,
                  'Observed sclera edges retained; hidden area directly behind visible iris interpolated from both scleral flanks. Other occluded material not inferred.',
                  'inpainted', visible_white),
            _part(tag('eye:iris'), tile, front, x, y, 'Visible iris pigmentation and enclosed highlights copied in source coordinates. Occluded iris outside this aperture not reconstructed.'),
            _part(tag('eye:lash:upper'), tile, upper, x, y, 'Continuous observed upper lid stroke sampled in original pixels.')]
    if lower is not None:
        made.append(_part(tag('eye:lash:lower'), tile, lower, x, y, 'Visible lower lid contour retained from this eye.'))
    return made, (x+ix+iw*.5, y+iy+ih*.5)


def _mouth(source, eyes):
    """Accept only an isolated, closed, slender line on surrounding skin below both eyes."""
    delta = np.subtract(eyes[0], eyes[1])
    distance = float(np.hypot(*delta))
    if distance < 12 or abs(delta[1]) > distance*.22:
        return None
    center = np.mean(eyes, axis=0)
    H, W = source.shape[:2]
    x, y = max(0, round(center[0]-.5*distance)), max(0, round(center[1]+.38*distance))
    xx, yy = min(W, round(center[0]+.5*distance)), min(H, round(center[1]+1.2*distance))
    tile = source[y:yy,x:xx]
    if min(tile.shape[:2]) < 5:
        return None
    gray = cv2.cvtColor(tile[:,:,:3].copy(), cv2.COLOR_RGB2GRAY)
    d = max(3,round(distance*.16))|1
    background = cv2.morphologyEx(gray,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(d,d)))
    contrast = background.astype(float)-gray
    candidates = (contrast > 7) & (tile[:,:,3]>235)
    # A thin smile can fade below the core threshold at the center. Group both
    # ends across a short gap but only retain pixels supported by actual contrast.
    grouped=cv2.morphologyEx(candidates.astype(np.uint8),cv2.MORPH_CLOSE,
                             np.ones((1,max(3,round(distance*.12))|1),np.uint8))
    viable=[]
    for group,(bx,by,w,h,area),(cx,cy) in _components(grouped):
        if (not .28*distance < w < .87*distance or h > max(3,.18*distance) or w < h*3 or
                abs(x+cx-center[0]) > distance*.14 or by < 1 or by+h+1 >= tile.shape[0]):
            continue
        # A closed mouth has one slender trace and similar surrounding color
        # above and below. An actual opening, hairline or clothing seam is excluded.
        before,after = tile[by-1,bx:bx+w,:3],tile[by+h,bx:bx+w,:3]
        if np.median(np.linalg.norm(before.astype(float)-after,axis=1)) > 21 or np.mean(before) < 105:
            continue
        mask=group & (contrast>=2)
        if mask[:,bx:bx+w].sum(0).max() > max(3,distance*.085):
            continue
        # Complete only connected anti-aliased pixels of this observed trace.
        edges=cv2.dilate(mask.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
        mask |= edges & (contrast>=2) & (tile[:,:,3]>235)
        viable.append(_part('mouth:closed',tile,mask,x,y,'Single observed closed mouth stroke; no separate lower lip, oral cavity, tongue or teeth inferred.'))
    return viable[0] if len(viable)==1 else None


def extract_face_details(source, observed_regions):
    if source.ndim != 3 or source.shape[2] != 4 or source.dtype != np.uint8:
        raise ValueError('Expected source RGBA uint8 pixels')
    H, W = source.shape[:2]
    parts, centers, boxes_by_side = [], [], {}
    for side, label in [('left','eye_l'), ('right','eye_r')]:
        boxes = [row.get('box') for row in observed_regions if isinstance(row,dict) and row.get('semantic') == label]
        if len(boxes)!=1:
            continue
        box = _bounds(boxes[0], W, H)
        if box:
            boxes_by_side[side] = box
    if len(boxes_by_side)==2:
        (x,y,w,h),(xx,yy,ww,hh) = boxes_by_side.values()
        shared=max(0,min(x+w,xx+ww)-max(x,xx))*max(0,min(y+h,yy+hh)-max(y,yy))
        if shared > .20*min(w*h,ww*hh):
            return []
    for side,box in boxes_by_side.items():
        eye = _eye(source, box, side)
        if eye:
            material, center = eye
            parts.extend(material)
            centers.append(center)
    if len(centers)==2:
        mouth = _mouth(source, centers)
        if mouth:
            parts.append(mouth)
    return parts


def extract_forehead_patch(source, observed_regions):
    """Lift one identifiable fringe tip between observed eyes and infer nearby skin.

    The result is deliberately tagged as a partial hair detail and forehead
    backing. It cannot satisfy the full face/hair/neck material requirements.
    """
    if source.ndim != 3 or source.shape[2] != 4 or source.dtype != np.uint8:
        raise ValueError('Expected source RGBA uint8 pixels')
    H,W=source.shape[:2]
    eyes=[]
    for name in ('eye_l','eye_r'):
        choices=[r.get('box') for r in observed_regions if isinstance(r,dict) and r.get('semantic')==name]
        if len(choices)!=1:
            return []
        box=_bounds(choices[0],W,H)
        if not box:
            return []
        eyes.append(box)
    eyes.sort(key=lambda e:e[0])
    centers=np.array([[x+w*.5,y+h*.5] for x,y,w,h in eyes])
    ex,ey=centers.mean(0)
    dist=centers[1,0]-centers[0,0]
    if dist<18 or abs(centers[0,1]-centers[1,1])>dist*.18:
        return []
    # Sample hair well above the eyes, and skin at the bridge of the nose below
    # the brow. Require a predictable separation along the observed chroma axis.
    def sample(ax,bx,ay,by):
        x0,x1=max(0,math.floor(ex+ax*dist+.5)),min(W,math.floor(ex+bx*dist+.5))
        y0,y1=max(0,math.floor(ey+ay*dist+.5)),min(H,math.floor(ey+by*dist+.5))
        return x0,y0,source[y0:y1,x0:x1]
    _,_,crown=sample(-.32,.32,-1.0,-.7)
    _,_,bridge=sample(-.14,.14,.07,.36)
    x,y,tile=sample(-.63,.63,-.69,.03)
    if min(crown.shape[:2]+bridge.shape[:2]+tile.shape[:2])<2:
        return []
    def colors(im):
        return cv2.cvtColor(im[:,:,:3].copy(),cv2.COLOR_RGB2LAB).astype(float)
    def chroma(im):
        samples=colors(im)[im[:,:,3]>238]
        return np.median(samples[:,1:],axis=0) if len(samples)>=8 else None
    hair,skin=chroma(crown),chroma(bridge)
    if hair is None or skin is None:
        return []
    vector=skin-hair
    if np.linalg.norm(vector)<5:
        return []
    lab=colors(tile);opacity=tile[:,:,3]>238
    # The skin may be substantially warmer/darker directly under a fringe.
    # Relative chroma is steadier here than a global brightness threshold.
    factor=(lab[:,:,1:]-hair)@vector/np.dot(vector,vector)
    hair_like=(factor<1.02)&opacity
    skin_like=(factor>1.28)&opacity
    for xx,yy,ww,hh in eyes:
        y0=max(0,yy-y);x0,x1=max(0,xx-x),min(tile.shape[1],xx+ww-x)
        hair_like[y0:,x0:x1]=False
        skin_like[y0:,x0:x1]=False
    reach=np.zeros_like(hair_like)
    for group,(_,sy,w,h,n),_ in _components(hair_like):
        if sy==0 and w>=.1*dist:
            reach |= group
    if not reach.any():
        return []
    # Isolate a lobe with a single narrow root, tapering to a real lower tip;
    # reject flat/noisy hairlines and reject components cut by the ROI sides.
    candidates=[]
    rows,cols=np.indices(reach.shape)
    for cut in range(max(0,round(tile.shape[0]-.44*dist)),tile.shape[0]-2,max(1,round(dist*.02))):
        for component,(sx,sy,w,h,n),(cx,cy) in _components(reach&(rows>=cut)):
            if (sy!=cut or sx==0 or sx+w>=tile.shape[1] or
                    not .14*dist<h<.41*dist or not .12*dist<w<.70*dist or
                    abs(x+cx-ex)>dist*.24 or n<10):
                continue
            root_width=int(component[cut].sum())
            tip_width=int(component[sy+h-1].sum())
            if root_width<3 or root_width<tip_width*1.6 or root_width<w*.42:
                continue
            # The visible tip should meet skin along both edges below the root.
            neighbor=cv2.dilate(component.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)&~component
            edge=neighbor&(rows>cut)
            if not edge.any() or (edge&skin_like).sum()<.25*edge.sum():
                continue
            candidates.append((h*n/(1+abs(x+cx-ex)/dist),component))
    if not candidates:
        return []
    mask=max(candidates,key=lambda item:item[0])[1]
    # Include the dark antialiased hairline and its narrow fringe shadow.
    # Skin/hair chroma overlap on that rim; use the brighter cheek/bridge as
    # a second cue, and protect the observed eyelids where their ROIs touch.
    _,by,_,height=cv2.boundingRect(mask.astype(np.uint8))
    bridge_light=np.median(colors(bridge)[bridge[:,:,3]>238,0])
    rim_radius=max(1,round(dist*.065))
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*rim_radius+1,2*rim_radius+1))
    rim=cv2.dilate(mask.astype(np.uint8),kernel).astype(bool)
    wider=2*rim_radius+3
    low_rim=cv2.dilate(mask.astype(np.uint8),cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(wider,wider))).astype(bool)
    rim |= low_rim & (rows>=by+height*.65)
    protected=np.zeros_like(mask)
    for box in eyes:
        eye=_eye(source,box,'eye')
        if not eye:
            return []
        for part in eye[0]:
            a=part['rgba'];xx,yy=part['x']-x,part['y']-y
            ah,aw=a.shape[:2]
            top,bottom=max(0,yy),min(yy+ah,protected.shape[0])
            left,right=max(0,xx),min(xx+aw,protected.shape[1])
            if top<bottom and left<right:
                protected[top:bottom,left:right]|=a[top-yy:bottom-yy,left-xx:right-xx,3]>0
    if (mask&protected).sum()>mask.sum()*.04:
        return []
    protected=cv2.dilate(protected.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    mask &= ~protected
    mask |= rim & (rows>by) & (lab[:,:,0]<bridge_light-12) & opacity & ~protected
    outer=cv2.dilate(mask.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    mask |= outer & (rows>by+height*.70) & (lab[:,:,0]<bridge_light-18) & opacity & ~protected
    # Interpolate a smooth 2-D forehead field from similarly illuminated skin
    # on *both* sides. A hard per-row choice of nearest pixels causes banding.
    donors=skin_like & ~rim & ~protected & (lab[:,:,0]>bridge_light-42)
    center=np.mean(np.nonzero(mask)[1])
    scale=max(2.,dist*.17)
    def diffuse(samples):
        return cv2.GaussianBlur(samples.astype(np.float32),(0,0),sigmaX=scale,sigmaY=scale*.8,
                                borderType=cv2.BORDER_CONSTANT)
    # Fast finite-support Gaussian interpolation independent of the number of
    # target/donor pairs. Both sides must contribute inside the entire cut.
    left=diffuse(donors & (cols<center))
    right=diffuse(donors & (cols>=center))
    if min(left[mask].min(),right[mask].min())<.0002:
        return []
    weights=left+right
    interpolated=diffuse(tile[:,:,:3]*donors[:,:,None])
    filled=tile.copy()
    filled[mask,:3]=np.rint(interpolated[mask]/weights[mask,None]).clip(0,255).astype(np.uint8)
    backing=_part('forehead:fringe-underpaint',filled,mask,x,y,
                  'Partial inferred forehead under one central fringe tip. Smooth two-sided interpolation from nearby exposed forehead skin; identity and full forehead remain unverified.',
                  'inpainted',np.zeros_like(mask))
    backing['erase']=False
    tip=_part('fringe:central-tip',tile,mask,x,y,'Small observed forehead lock. This is only the tip; its top remains anchored to the adjacent original fringe.')
    return [backing,tip]


def _split_jaw_edge(source, neck, jaw, selected):
    """Keep translucency and original composite at antialiased jaw/neck pixels."""
    rows,cols=np.nonzero(selected & (source[:,:,3]<255))
    samples=source[rows,cols]
    # An opaque face needs no compensation. For translucent ink, find the
    # highest neck opacity that still reproduces its original RGBA exactly.
    if not len(rows):
        return
    unresolved=np.ones(len(samples),bool)
    sa=samples[:,3].astype(float)
    skin=neck[rows,cols,:3].astype(float)
    neck[rows,cols,3]=0
    for fraction in (.94,.83,.7,.5,.3):
        if not unresolved.any():
            break
        b=np.rint(sa*fraction)
        g=np.rint((sa-b)*255/(255-b))
        bw=b*(1-g/255)
        face=np.empty_like(samples)
        face[:,:3]=np.clip(np.rint((samples[:,:3]*(g+bw)[:,None]-skin*bw[:,None])/g[:,None]),0,255)
        face[:,3]=g
        under=neck[rows,cols].copy()
        under[:,3]=b
        check=np.asarray(Image.alpha_composite(Image.fromarray(under[None,:,:]),Image.fromarray(face[None,:,:])))[0]
        solved=unresolved & (check==samples).all(1)
        neck[rows[solved],cols[solved],3]=b[solved]
        jaw[rows[solved],cols[solved]]=face[solved]
        unresolved[solved]=False


def extract_neck_plate(source, observed_regions):
    """Extract neck skin bounded by a visible jaw and garment; infer a short under-chin overlap."""
    details={p['semantic']:p for p in extract_face_details(source,observed_regions)}
    if not all(key in details for key in ('eye:iris:left','eye:iris:right','mouth:closed')):
        return []
    def center(part):
        return np.array([part['x']+part['rgba'].shape[1]/2,part['y']+part['rgba'].shape[0]/2])
    eyes=[center(details['eye:iris:'+side]) for side in ('left','right')]
    mouth=center(details['mouth:closed']);dist=abs(eyes[0][0]-eyes[1][0])
    if dist<20 or abs(eyes[0][1]-eyes[1][1])>dist*.16:
        return []
    cx,my=mouth
    H,W=source.shape[:2]
    x=max(0,int(cx-dist*.65));y=max(0,int(my+dist*.08))
    tile=source[y:min(H,math.ceil(my+dist*1.53)),x:min(W,math.ceil(cx+dist*.65))]
    if min(tile.shape[:2])<dist*.75:
        return []
    h,w=tile.shape[:2];mid=round(cx-x)
    lab=cv2.cvtColor(tile[:,:,:3].copy(),cv2.COLOR_RGB2LAB).astype(float)
    alpha=tile[:,:,3];rows,cols=np.indices((h,w))
    radius=max(1,round(dist*.055))
    light=cv2.GaussianBlur(lab[:,:,0],(3,3),.7)
    upper=light[np.maximum(0,rows-radius),cols]
    lower=light[np.minimum(h-1,rows+radius),cols]
    gradient=upper-lower
    near=np.abs(np.arange(w)-mid)<=max(1,round(dist*.055))
    candidates=np.flatnonzero((y+np.arange(h)>my+dist*.20)&(y+np.arange(h)<my+dist*.72))
    if not len(candidates):
        return []
    chin=int(candidates[np.argmax(np.median(gradient[candidates][:,near],axis=1))])
    if np.median(gradient[chin,near])<20:
        return []
    # Trace the actual jaw stroke rather than treating the chin as a horizontal cut.
    target=chin-abs(cols-mid)*.45
    eligible=(abs(rows-target)<dist*.15)&(alpha>150)
    edge=np.argmax(np.where(eligible,gradient-2*abs(rows-target),-1000),axis=0)
    edge_confident=gradient[edge,np.arange(w)]>14
    if edge_confident[near].mean()<.8:
        return []
    shaft=(rows>chin+.10*dist)&(rows<chin+.30*dist)&(abs(cols-mid)<.12*dist)&(alpha>238)
    if shaft.sum()<8:
        return []
    shade=np.median(lab[shaft],axis=0)
    if np.percentile(np.linalg.norm(lab[shaft]-shade,axis=1),85)>32:
        return []
    # An uninterrupted color band must connect the center shaft to a closed
    # collar or clear background. Refuse an open crop extending into the chest.
    chroma=np.linalg.norm(lab[:,:,1:]-shade[1:],axis=2)
    skin=(chroma<19)&(lab[:,:,0]>shade[0]-55)&(lab[:,:,0]<shade[0]+64)&(alpha>50)
    possible=skin & edge_confident[None,:] & (rows>=edge[None,:]+radius)
    neck=None
    for component,(bx,by,bw,bh,n),_ in _components(possible):
        if (component&shaft).sum()<shaft.sum()*.8 or not (.38*dist<bw<1.18*dist and .35*dist<bh<1.12*dist):
            continue
        if bx==0 or bx+bw==w or by+bh>=h:
            continue
        neck=component
        break
    if neck is None:
        return []
    # Allow continuous antialiased skin up to the visible boundary, without
    # transferring red hair or a differently colored shirt collar onto the neck.
    rim=cv2.dilate(neck.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    neck |= rim & (alpha>0) & (chroma<21) & (lab[:,:,0]>shade[0]-66) & (rows>edge[None,:])
    # Keep the jaw ink and its antialiasing with the face. Starting the neck
    # at the first skin-colored transition would create two chins when it lifts.
    for col in np.flatnonzero(neck.any(0)):
        span=np.flatnonzero(neck[:,col])
        top=span[0]
        upper_band=span[span<top+max(3,round(dist*.10))]
        valley=upper_band[np.argmin(lab[upper_band,col,0])]
        cutoff=min(valley+max(2,round(dist*.06)),span[-1]+1)
        neck[:cutoff,col]=False
    first=np.argmax(neck,axis=0)
    if np.mean(first[near]) < np.mean(first[neck.any(0)])+dist*.025:
        return []
    # Extrapolate only a small overlap under the existing jaw from this
    # column's first few solid skin samples. Keep the jaw guard as source RGBA.
    depth=max(2,round(dist*.18))
    hidden=np.zeros_like(neck);paint=tile.copy()
    for col in np.flatnonzero(neck.any(0)):
        samples=np.flatnonzero(neck[:,col]&(alpha[:,col]>200))
        if len(samples)<radius+2:
            continue
        top=first[col]
        chosen=samples[(samples>=top+radius)&(samples<top+radius*3+2)]
        if len(chosen)<2:
            continue
        start=max(0,top-depth)
        eligible=alpha[start:top,col]>=240
        hidden[start:top,col]=eligible
        paint[start:top,col,:3]=np.median(tile[chosen,col,:3],axis=0).astype(np.uint8)
    if hidden.sum()<dist*depth*.34:
        return []
    # The overlap should stay softly shaded between columns at the hidden top.
    weights=cv2.GaussianBlur(hidden.astype(np.float32),(0,0),max(1.,dist*.045))
    smooth=cv2.GaussianBlur((paint[:,:,:3]*hidden[:,:,None]).astype(np.float32),(0,0),max(1.,dist*.045))
    paint[hidden,:3]=np.rint(smooth[hidden]/weights[hidden,None]).clip(0,255).astype(np.uint8)
    jaw=tile.copy()
    _split_jaw_edge(tile,paint,jaw,hidden)
    plate=_part('neck',paint,neck|hidden,x,y,'Visible neck from source jaw to collar; a short upper overlap extrapolates that same neck shadow under the chin. Exposed shoulders and collar are separate.', 'inpainted',neck)
    guard=_part('face:detail:chin-overlap',jaw,hidden,x,y,'Source jaw silhouette and ink over the neck. Its antialiasing is compensated to restore the original RGBA. Move this layer with the face.')
    return [plate,guard]
