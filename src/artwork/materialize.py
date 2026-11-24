"""Register actual provider pixels against the submitted source, without inventing poses."""
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from facial_materials import extract_face_details, extract_forehead_patch, extract_neck_plate
from source_head import place_boxed_layers, split_registered_head, source_owner, extend_observed_lids
from body_materials import build_source_body

cv2.setNumThreads(1)
Image.MAX_IMAGE_PIXELS = 16 * 1024 * 1024


def read_image(path):
    with Image.open(path) as im:
        return np.array(im.convert("RGBA"))


def bounds(mask):
    points = cv2.findNonZero(mask.astype(np.uint8))
    return cv2.boundingRect(points) if points is not None else None


def crop(image, box):
    x, y, w, h = box
    return image[y:y+h, x:x+w]


def rgba_crop(image, mask):
    out = image.copy()
    out[:, :, 3] = np.where(mask, image[:, :, 3], 0)
    return out


def scaled(image, w, h):
    return cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA)


def match_layer(source, layer, scales):
    """Only accept a translation/scale supported by textured matching pixels."""
    box = bounds(layer[:, :, 3] > 16)
    if not box:
        return None
    tile = crop(layer, box)
    h, w = source.shape[:2]
    shrink = min(1, 420 / max(w, h))
    target = scaled(source[:, :, :3], round(w*shrink), round(h*shrink))
    best = None
    for scale in scales:
        tw, th = round(tile.shape[1]*scale), round(tile.shape[0]*scale)
        sw, sh = round(tw*shrink), round(th*shrink)
        if min(sw, sh) < 4 or tw > w or th > h or sw > target.shape[1] or sh > target.shape[0]:
            continue
        sample = scaled(tile, sw, sh)
        mask = (sample[:, :, 3] >= 180).astype(np.uint8)
        count = int(mask.sum())
        if count < 14 or sample[:, :, :3][mask != 0].std(axis=0).mean() < 6:
            continue
        score = cv2.matchTemplate(target, sample[:, :, :3], cv2.TM_SQDIFF, mask=mask)
        first, _, (cx, cy), _ = cv2.minMaxLoc(score)
        # A repeated motif (e.g. two identical eyes) is not enough to choose a side.
        alternatives=score.copy()
        radius=max(2,min(sw,sh)//4)
        alternatives[max(0,cy-radius):cy+radius+1,max(0,cx-radius):cx+radius+1]=np.inf
        if np.min(alternatives) <= max(first*1.5,first+16*3*count):
            continue
        pad = math.ceil(2/shrink)
        x = min(max(0, round(cx/shrink)-pad), w-tw)
        y = min(max(0, round(cy/shrink)-pad), h-th)
        window = source[y:min(h,y+th+2*pad+1), x:min(w,x+tw+2*pad+1)]
        full = scaled(tile, tw, th)
        solid = (full[:, :, 3] >= 180).astype(np.uint8)
        fine = cv2.matchTemplate(window[:, :, :3], full[:, :, :3], cv2.TM_SQDIFF, mask=solid)
        _, _, (dx, dy), _ = cv2.minMaxLoc(fine)
        xx, yy = x+dx, y+dy
        original = source[yy:yy+th, xx:xx+tw]
        delta = np.abs(original[:, :, :3].astype(np.int16) - full[:, :, :3])
        good = (delta.max(axis=2) <= 18) & (original[:, :, 3] >= 160) & (solid > 0)
        count = int(good.sum())
        ratio = count / max(1, int(solid.sum()))
        if ratio >= .70 and count >= 16 and (best is None or ratio > best[0]):
            best = (ratio, xx, yy, scale, full, good, box)
    return best


SEMANTICS = {
    'face', 'neck', 'hair:front', 'hair:back', 'nose', 'upper-body', 'lower-body',
    'mouth:closed', 'mouth:open', 'mouth:line:upper', 'mouth:line:lower',
    'gesture:wave:raised', 'gesture:wave:rest', 'appearance:chest_bow', 'appearance:chest_bow:underlay',
}
SEMANTICS.update(f'{tag}:{side}' for side in ('left', 'right') for tag in (
    'brow', 'eye:white', 'eye:iris', 'eye:lash:upper', 'eye:lash:lower', 'eye:closed'))


def known_semantic(label):
    return label if isinstance(label, str) and label in SEMANTICS else None


def read_regions(items, width, height):
    regions = {}
    for item in items:
        label = item.get('semantic')
        semantic = known_semantic({'brow_l':'brow:left','brow_r':'brow:right'}.get(label,label))
        box = item.get('box')
        if not semantic or not isinstance(box,list) or len(box)!=4 or not all(isinstance(v,(float,int)) and math.isfinite(v) and 0<=v<=1 for v in box):
            continue
        x0,y0,x1,y1 = box
        x,y = int(x0*width),int(y0*height)
        w,h = math.ceil(x1*width)-x,math.ceil(y1*height)-y
        if min(w,h)>=2 and semantic not in regions:
            regions[semantic]=(x,y,w,h)
    return regions


def overlay_semantic(rect, regions):
    x,y,w,h=rect
    matches=[]
    for semantic,(xx,yy,ww,hh) in regions.items():
        area=max(0,min(x+w,xx+ww)-max(x,xx))*max(0,min(y+h,yy+hh)-max(y,yy))
        iou=area/(w*h+ww*hh-area)
        if iou>.62:
            matches.append((iou,semantic))
    matches.sort(reverse=True)
    if matches and (len(matches)==1 or matches[0][0]-matches[1][0]>.2):
        return matches[0][1]
    return None


def segmented_detail(source, box):
    """Isolate an observed feature inside its image-analysis box; refuse ambiguous masks."""
    x,y,w,h=box
    H,W=source.shape[:2]
    pad=max(3,round(min(w,h)*.3))
    xx,yy=max(0,x-pad),max(0,y-pad)
    local=source[yy:min(y+h+pad,H),xx:min(x+w+pad,W)]
    if min(w,h)<3 or local.shape[0]*local.shape[1]>300000:
        return None
    mask=np.zeros(local.shape[:2],np.uint8)
    mask[y-yy:y-yy+h,x-xx:x-xx+w]=cv2.GC_PR_FGD
    if not np.any(mask==cv2.GC_BGD):
        return None
    mask[local[:,:,3]<16]=cv2.GC_BGD
    # GrabCut needs foreground observations for small ornaments surrounded by
    # the same palette. Seed colors concentrated inside the central box versus its ring.
    cv2.setRNGSeed(81)
    lab=cv2.cvtColor(local[:,:,:3],cv2.COLOR_RGB2LAB).astype(np.float32)
    _,ids,_=cv2.kmeans(lab.reshape(-1,3),6,None,
                       (cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_MAX_ITER,20,.2),1,cv2.KMEANS_PP_CENTERS)
    ids=ids.reshape(mask.shape)
    middle=np.zeros_like(mask,dtype=bool)
    middle[y-yy+h//5:y-yy+h-h//5,x-xx+w//5:x-xx+w-w//5]=True
    infg=np.bincount(ids[middle],minlength=6)/max(1,middle.sum())
    border=(mask==cv2.GC_BGD)
    inbg=np.bincount(ids[border],minlength=6)/max(1,border.sum())
    discrimination=infg/(.03+inbg)
    seed=int(np.argmax(discrimination))
    if infg[seed]<.045 or discrimination[seed]<1.7:
        return None
    mask[middle&(ids==seed)&(local[:,:,3]>=128)]=cv2.GC_FGD
    cv2.grabCut(local[:,:,:3].copy(),mask,None,np.zeros((1,65)),np.zeros((1,65)),4,cv2.GC_INIT_WITH_MASK)
    feature=(mask==cv2.GC_FGD)|(mask==cv2.GC_PR_FGD)
    part=feature[y-yy:y-yy+h,x-xx:x-xx+w]
    fraction=part.mean()
    if not .045<fraction<.91 or int(part.sum())<8:
        return None
    # Keep antialiased transition pixels with the original feature during removal.
    grown=cv2.dilate(part.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    if grown.mean()>.95:
        return None
    return grown


def rest_arm(source, box):
    mask=segmented_detail(source,box)
    if mask is None:
        return None
    tile=crop(source,box)
    h,w=mask.shape
    # Learn the lower arm color from its own high-coverage interior.
    # Discard adjacent skirt/sash pixels GrabCut picked up at the wrist.
    lab=cv2.cvtColor(tile[:,:,:3],cv2.COLOR_RGB2LAB).astype(np.int16)
    mid=mask[h*2//3:h*4//5]
    sample=lab[h*2//3:h*4//5][mid]
    if len(sample)<12:
        return None
    cv2.setRNGSeed(81)
    _,idx,centers=cv2.kmeans(sample.astype(np.float32),3,None,
        (cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_MAX_ITER,20,.2),1,cv2.KMEANS_PP_CENTERS)
    color=centers[np.argmax(np.bincount(idx.flatten(),minlength=3))]
    delta=np.linalg.norm(lab-color,axis=2)
    core=(delta<34)&mask
    rows=np.flatnonzero(core.sum(1)>=max(3,w*.05))
    if not len(rows) or rows[0]>h*.7 or rows[-1]<h*.85:
        return None
    # Leave the whole cuff with the sleeve until visible skin spans most of
    # the segmented row. A fixed transition sliced through the lower cuff.
    arm_rows=np.flatnonzero(core.sum(1)>.42*np.maximum(1,mask.sum(1)))
    if not len(arm_rows):
        return None
    skin_start=max(rows[0],int(arm_rows[0]))
    # The inner cuff can hang below the outer cuff. Keep the complete observed
    # sleeve until its transverse width reaches the narrower bare arm.
    limit=min(h,skin_start+max(3,round(h*.14)))
    widths=np.count_nonzero(mask[skin_start:limit],axis=1)
    if widths.size:
        skin_start+=int(np.argmin(np.convolve(np.pad(widths,(1,1),mode='edge'),np.ones(3),mode='valid')))
    for row in range(skin_start,h):
        xx=np.flatnonzero(core[row])
        if len(xx)>1:
            mask[row,:max(0,xx[0]-2)]=False
            mask[row,min(w,xx[-1]+3):]=False
        elif row>rows[-1]+1:
            mask[row]=False
    # Recover dark sleeve ties occluding transparency next to the cuff.
    # A connected run on the outside of the observed sleeve is anchored to its contour.
    outer=(tile[:,:,3]>48)&(np.mean(tile[:,:,:3],axis=2)<78)
    count,labels,stats,_=cv2.connectedComponentsWithStats(outer.astype(np.uint8))
    near=cv2.dilate(mask.astype(np.uint8),np.ones((5,5),np.uint8)).astype(bool)
    for idx in range(1,count):
        x,y,ww,hh,area=map(int,stats[idx])
        region=labels==idx
        if area>=5 and y>h*.12 and y+hh<rows[0]+h*.12 and np.any(region&near):
            mask |= region
    exterior=(tile[:,:,3]<24).astype(np.uint8)
    boundary=cv2.dilate(exterior,np.ones((3,3),np.uint8)).astype(bool)
    near=cv2.dilate(mask.astype(np.uint8),np.ones((9,9),np.uint8)).astype(bool)
    mask |= (tile[:,:,3]>0)&boundary&near
    # Recover the shaded arm outline next to the sash. Chroma distances from
    # this arm's observed skin are insensitive to the dark outline luminance.
    chroma=np.linalg.norm(lab[:,:,1:]-color[1:],axis=2)
    skin_edge=(chroma<29)&(tile[:,:,3]>0)
    skin_edge[:skin_start]=False
    for _ in range(5):
        grow=cv2.dilate(mask.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
        mask |= skin_edge & grow
    # Remove isolated specks that would be left hovering where this arm moved.
    remnants=((tile[:,:,3]>0)&~mask).astype(np.uint8)
    count,labels,stats,_=cv2.connectedComponentsWithStats(remnants)
    near=cv2.dilate(mask.astype(np.uint8),np.ones((7,7),np.uint8)).astype(bool)
    for idx in range(1,count):
        region=labels==idx
        if int(stats[idx,cv2.CC_STAT_AREA])<=max(12,w*.25) and np.any(region&near):
            mask |= region
    # At the forearm / garment boundary, keep the inked divide with the
    # sash or skirt. Its dark center is observable even where its shade is
    # similar to the skin shadow. Work inside the subject's interior only.
    x,y,_,_=box
    distance=max(3,round(w*.085))
    alpha=source[y+skin_start:y+h,:,3]>180
    left=alpha[:,max(0,x-distance):x].sum()
    right=alpha[:,x+w:min(source.shape[1],x+w+distance)].sum()
    if max(left,right)>2*max(1,min(left,right)):
        inward=1 if left>right else -1
        seam=mask[:,::inward]
        local=tile[:,::inward]
        light=lab[:,::inward,0]
        for row in range(h):
            covered=np.flatnonzero(seam[row])
            if not len(covered):
                continue
            start=covered[0]
            if start<distance or start+distance>=w:
                continue
            solid=local[row,start-distance:start+distance+1,3]
            if solid.min()<240:
                continue
            left_tone=np.mean(light[row,start-distance:start-distance//2])
            right_tone=np.mean(light[row,start+distance//2:start+distance+1])
            # Search only a short distance around the observed skin/cloth
            # boundary. Preserve the ink center and remove the skin-side rim.
            radius=max(2,distance//2)
            xx=np.arange(start-radius,start+radius+1)
            darkness=min(left_tone,right_tone)-light[row,xx]-1.5*np.abs(xx-start)
            best=int(np.argmax(darkness))
            if darkness[best]>10:
                edge=xx[best]
                seam[row,max(0,start-radius):edge+1]=False
                seam[row,edge+1:start+radius+1]=True
    rect=bounds(mask)
    if not rect or rect[2]<w*.55 or rect[3]<h*.83:
        return None
    return mask


def registered_wave(source, generated, rest):
    """Verify the edited pose still attaches to visible shoulder pixels in source space."""
    H,W=source.shape[:2]
    gh,gw=generated.shape[:2]
    if not rest or abs((gw/gh)/(W/H)-1)>.025:
        return None
    wave=scaled(generated,W,H)
    binary=(wave[:,:,3]>32).astype(np.uint8)
    count,labels,stats,_=cv2.connectedComponentsWithStats(binary)
    if count<2:
        return None
    order=np.argsort(stats[1:,cv2.CC_STAT_AREA])[::-1]+1
    idx=int(order[0])
    x,y,w,h,area=map(int,stats[idx])
    if not W*H*.001<area<W*H*.22 or area<.95*int(binary.sum()):
        return None
    rx,ry,rw,rh=rest
    # A wave rises above this shoulder and leaves the hanging arm position open.
    if y>ry-rh*.12 or y+h>ry+rh*.8:
        return None
    feature=labels==idx
    resting=rest_arm(source,rest)
    if resting is None:
        return None
    # Register the shared sleeve using observed garment color, including its
    # area and centroid. This corrects hand/arm enlargement by the image editor.
    src=crop(source,rest)
    sample=src[:max(3,round(rh*.43))]
    solid=resting[:sample.shape[0]]&(sample[:,:,3]>180)
    if solid.sum()<18:
        return None
    colors=cv2.cvtColor(sample[:,:,:3],cv2.COLOR_RGB2LAB)
    _,ids,centers=cv2.kmeans(colors[solid].astype(np.float32),3,None,
        (cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_MAX_ITER,20,.2),1,cv2.KMEANS_PP_CENTERS)
    dominant=centers[np.argmax(np.bincount(ids.flatten(),minlength=3))]
    def garment(im,allowed):
        lab=cv2.cvtColor(im[:,:,:3],cv2.COLOR_RGB2LAB).astype(np.float32)
        return (np.linalg.norm(lab-dominant,axis=2)<19)&allowed
    original_garment=garment(src,resting)
    generated_garment=garment(wave,feature)
    if min(original_garment.sum(),generated_garment.sum())<18:
        return None
    scale=math.sqrt(original_garment.sum()/generated_garment.sum())
    if not .5<scale<1.6:
        return None
    oy,ox=np.mean(np.argwhere(original_garment),axis=0)
    gy,gx=np.mean(np.argwhere(generated_garment),axis=0)
    matrix=np.array([[scale,0,rx+ox-gx*scale],[0,scale,ry+oy-gy*scale]],np.float32)
    wave=cv2.warpAffine(wave,matrix,(W,H),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
    feature=cv2.warpAffine(feature.astype(np.uint8),matrix,(W,H),flags=cv2.INTER_NEAREST).astype(bool)
    sy,sx=slice(ry,ry+max(2,round(rh*.28))),slice(rx,rx+rw)
    attachment=feature[sy,sx]&(source[sy,sx,3]>192)
    if int(attachment.sum())<max(10,rw*rh*.018):
        return None
    # Check garment colors where the new cap physically overlaps the old shoulder.
    a=wave[sy,sx,:3][attachment].astype(np.int16)
    b=source[sy,sx,:3][attachment].astype(np.int16)
    if np.mean(np.max(np.abs(a-b),axis=1)<45)<.3:
        return None
    grown=cv2.dilate(feature.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    out=rgba_crop(wave,grown)
    # The edit sometimes redraws a strip of neckline on its sleeve. Register
    # the inner cap to the original torso seam, leaving the raised wrist, cuff
    # and fingers from the proposed pose. The hand determines the outward side.
    hand=feature[:ry]
    hand_x=np.nonzero(hand)[1]
    if hand_x.size and abs(np.median(hand_x)-(rx+ox))>rw*.4:
        step=1 if np.median(hand_x) > rx+ox else -1
        cloth_rows=np.nonzero(original_garment)[0]
        cuff_end=min(rh,round(np.percentile(cloth_rows,98)+rh*.07))
        columns=np.arange(W)
        to_cap=cv2.distanceTransform((out[:,:,3]<96).astype(np.uint8),cv2.DIST_L2,3)
        for row in range(cuff_end):
            material=np.flatnonzero(resting[row])
            if not len(material):
                continue
            inner=rx+(material[0] if step==1 else material[-1])
            along=(columns-inner)*step
            # The last few rows of the old sleeve diverge into a different
            # pose. Keep only the observed torso-side outline there.
            remaining=cuff_end-row
            extent=min(rw*.48,max(3,remaining*.95))
            weight=np.clip((extent-along)/max(2.,extent*.60),0,1)
            weight[along>extent]=0
            affected=(along >= -rw*.22)&(along <= extent)
            original=source[ry+row].copy()
            owned=np.zeros(W,bool)
            owned[rx:rx+rw]=resting[row]
            original[:,3][~owned]=0
            old=out[ry+row]
            old_alpha=old[:,3]/255
            support=np.clip((np.clip(remaining*.26,2.,8.)-to_cap[ry+row])/2.,0,1)
            new_alpha=original[:,3]/255*support
            wa=old_alpha*(1-weight);wb=new_alpha*weight
            alpha=wa+wb
            colors=(old[:,:3]*wa[:,None]+original[:,:3]*wb[:,None])/np.maximum(.00001,alpha[:,None])
            old[affected,:3]=np.rint(colors[affected]).clip(0,255).astype(np.uint8)
            old[affected,3]=np.rint(255*alpha[affected]).astype(np.uint8)
    box=bounds(out[:,:,3]>0)
    return crop(out,box),box


def inferred_closed_lids(details):
    """Form each closed eyelid from that eye's actual upper lash and lower lid landmarks."""
    result=[]
    for side in ('left','right'):
        observed={p['semantic'].removesuffix(':'+side):p for p in details if p['semantic'].endswith(':'+side)}
        if not all(feature in observed for feature in ('eye:white','eye:iris','eye:lash:upper','eye:lash:lower')):
            continue
        upper,lower=observed['eye:lash:upper'],observed['eye:lash:lower']
        pixels=upper['rgba'];h,w=pixels.shape[:2]
        dark=(255-cv2.cvtColor(pixels[:,:,:3].copy(),cv2.COLOR_RGB2GRAY).astype(float))*pixels[:,:,3]/255
        columns=np.flatnonzero(dark.max(0)>30)
        if len(columns)<max(7,w*.7):
            continue
        rows=np.arange(h)[:,None]
        center=(dark*rows).sum(0)/np.maximum(1,dark.sum(0))+upper['y']
        edges=max(1,len(columns)//6)
        left=float(np.median(center[columns[:edges]]))
        right=float(np.median(center[columns[-edges:]]))
        lower_y=lower['y']+np.median(np.where(lower['rgba'][:,:,3]>0)[0])
        gap=lower_y-center[columns].min()
        if not 2<gap<w*.8:
            continue
        # Both canthi meet only partway down the aperture. At the center the
        # relaxed upper lid settles toward this eye's own observed lower line.
        t=np.clip((np.arange(w)-columns[0])/max(1,columns[-1]-columns[0]),0,1)
        target=(1-t)*left+t*right+gap*.13
        target+=4*t*(1-t)*(lower_y*.87+.13*np.median(center[columns])-target)
        top=round(min(target)-h/2-2)
        oh=h+int(np.ceil(np.ptp(target)))+5
        xx,yy=np.meshgrid(np.arange(w,dtype=np.float32),np.arange(oh,dtype=np.float32))
        # Resample premultiplied alpha, retaining the source lash tone without a halo.
        prem=pixels.astype(np.float32)
        prem[:,:,:3]*=prem[:,:,3:4]/255
        map_y=(yy+top-target)/.82+center-upper['y']
        drawn=cv2.remap(prem,xx,map_y.astype(np.float32),cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
        drawn[:,:,:3]*=255/np.maximum(1,drawn[:,:,3:4])
        rgba=np.rint(np.clip(drawn,0,255)).astype(np.uint8)
        box=bounds(rgba[:,:,3]>0)
        if box:
            bx,by,_,_=box
            result.append({'semantic':'eye:closed:'+side,'rgba':crop(rgba,box),'x':upper['x']+bx,'y':top+by,
                'origin':'generated','erase':False,'note':'Inferred closed-lid pose warped from this same eye’s observed upper lash to its own lower-lid anchors. Not an observed expression.'})
    return result


def inferred_speech_parts(source, details):
    """Open a character's observed closed-mouth stroke at its own endpoints."""
    stroke=next((p for p in details if p['semantic']=='mouth:closed'),None)
    whites=[p for p in details if p['semantic'].startswith('eye:white:')]
    if not stroke or len(whites)!=2:
        return []
    line=stroke['rgba'];h,w=line.shape[:2];x,y=stroke['x'],stroke['y']
    eye_separation=abs((whites[0]['x']+whites[0]['rgba'].shape[1]/2)-
                       (whites[1]['x']+whites[1]['rgba'].shape[1]/2))
    if not .28*eye_separation<w<.87*eye_separation or y<3 or y+h+3>=source.shape[0]:
        return []
    # Infer the midline from actual stroke contrast. Appearance depends on both
    # canthi of the mouth, the resting curvature, local skin, and original ink.
    skin=np.median(np.stack([source[y-2,x:x+w,:3],source[y+h+1,x:x+w,:3]]),axis=0)
    difference=np.linalg.norm(line[:,:,:3].astype(float)-skin,axis=2)*(line[:,:,3]/255)
    columns=np.flatnonzero(difference.max(0)>5)
    if len(columns)<max(5,w*.45) or columns[0]>w*.18 or columns[-1]<w*.82:
        return []
    rows=np.arange(h)[:,None]
    anchors=(difference[:,columns]*rows).sum(0)/np.maximum(1e-5,difference[:,columns].sum(0))
    trace=np.interp(np.arange(w),columns,anchors)
    ink=np.median(line[:,:,:3][difference>np.percentile(difference[difference>0],75)],axis=0)
    S=6;gap=min(w*.34,eye_separation*.205)
    ceiling=int(np.ceil(gap*.34))+2
    top=y-ceiling
    if top<0 or y+h+gap+2>=source.shape[0]:return []
    height=h+ceiling+int(np.ceil(gap))+2
    X=(np.arange(w*S)+.5)/S
    u=np.clip((X-columns[0]-.5)/max(1,columns[-1]-columns[0]),0,1)
    mid=np.interp(X-.5,np.arange(w),trace)+ceiling
    # Keep corners of the *measured* smile together. Its existing asymmetry
    # carries into both rims. Relax the center of the jaw farther than the lip.
    hinge=np.minimum(1,np.minimum(u/.24,(1-u)/.24)).clip(0,1)
    edge=np.sin(np.pi*u)*hinge
    upper=mid-gap*.23*edge
    lower=mid+gap*(.58+.21*u)*edge
    Y=(np.arange(height*S)+.5)[:,None]/S
    interval=np.maximum(.01,lower-upper)
    vertical=np.clip((Y-upper)/interval,0,1)
    mouth_area=(Y>=upper)&(Y<=lower)&(interval>.17)
    local_skin=skin[np.clip(np.floor(X).astype(int),0,w-1)]
    deep=local_skin*np.array([.48,.27,.32]);warm=local_skin*np.array([.73,.45,.48])
    # Dark upper recess, softer bounce light from the lower inside lip.
    light=(.08+.75*vertical**1.6+.16*np.cos((u-.45)*np.pi)*vertical)[:,:,None]
    inner=deep[None]*(1-light)+warm[None]*light
    result=[]
    def image_part(semantic,rgb,alpha,note):
        src=np.zeros((height*S,w*S,4),np.float32)
        src[:,:,:3]=rgb*alpha[:,:,None];src[:,:,3]=alpha*255
        small=cv2.resize(src,(w,height),interpolation=cv2.INTER_AREA)
        small[:,:,:3]*=255/np.maximum(1,small[:,:,3:4])
        rgba=np.rint(np.clip(small,0,255)).astype(np.uint8)
        box=bounds(rgba[:,:,3]>0)
        if not box:return
        bx,by,_,_=box
        result.append({'semantic':semantic,'rgba':crop(rgba,box),'x':x+bx,'y':top+by,'origin':'generated',
                       'erase':False,'note':note})
    image_part('mouth:open',inner,mouth_area.astype(float),'Newly painted oral interior within this character’s measured mouth corners, from local skin and lip tones. Unseen anatomy inferred; no teeth or tongue asserted.')
    stroke_width=np.clip(h*.2,.65,1.3)
    rim_tint=np.clip(ink*np.array([.90,.75,.76]),0,255)
    for label,curve,tint,thickness in [('upper',upper,rim_tint,stroke_width),('lower',lower,ink*np.array([1,.83,.81]),stroke_width*.82)]:
        rim=(abs(Y-curve)<=thickness/2)&(X>columns[0])&(X<columns[-1]+1)
        image_part('mouth:line:'+label,tint,rim.astype(float),'Newly painted speech rim follows the observed smile trace, corner locations and lip palette; visible only while open.')
    return result


def facial_backing(source,details):
    """Reconstruct only the observed facial pixels assigned to moving details."""
    H,W=source.shape[:2]
    erase=np.zeros((H,W),np.uint8)
    for d in details:
        x,y=d['x'],d['y'];h,w=d['rgba'].shape[:2]
        if d.get('erase'):
            erase[y:y+h,x:x+w] |= d.get('eraseMask',d['rgba'][:,:,3]>0).astype(np.uint8)
    fill=cv2.inpaint(source[:,:,:3].copy(),erase,3,cv2.INPAINT_TELEA)
    for side in ('left','right'):
        eye=[d for d in details if d.get('erase') and d['semantic'].startswith('eye:') and d['semantic'].endswith(':'+side)]
        if not eye:continue
        x=min(p['x'] for p in eye);xx=max(p['x']+p['rgba'].shape[1] for p in eye)
        y=min(p['y'] for p in eye);yy=max(p['y']+p['rgba'].shape[0] for p in eye)
        if yy+3>=H or yy-y<3:continue
        below=source[yy+1:yy+3,x:xx]
        skin=np.median(below[:,:,:3],axis=0)
        # Keep the surrounding folds; reduce the dark ocular pigment that
        # isotropic inpainting can otherwise smear across the shuttered lid.
        reliable=(below[:,:,3].min(0)>215)&(skin.min(1)>95)&(skin.mean(1)>128)
        distance=cv2.distanceTransform(np.pad(erase[y:yy,x:xx],1),cv2.DIST_L2,3)[1:-1,1:-1]
        weight=np.minimum(0.43,distance*.11)*reliable
        patch=fill[y:yy,x:xx]
        patch[:]=np.rint(patch*(1-weight[:,:,None])+skin[None]*weight[:,:,None])
    return erase,fill


def soften_fringe(parts, rasters, source, donor):
    """Matte the bangs against their actual neutral backing, preserving visible RGB."""
    index=next((i for i,p in enumerate(parts) if p['id']=='registered-hair-front'),None)
    if index is None:return
    h,w=source.shape[:2]
    backing=Image.new('RGBA',(w,h))
    for p,img in zip(parts[:index],rasters[:index]):
        if p['visible'] and not p['reference']:
            backing.alpha_composite(Image.fromarray(img),(p['rect']['left'],p['rect']['top']))
    front=rasters[index];r=parts[index]['rect'];x,y=r['left'],r['top'];hh,ww=front.shape[:2]
    raw=np.asarray(backing)[y:y+hh,x:x+ww]
    support=(raw[:,:,3]==255)&(front[:,:,3]==255)
    if not support.any():return
    base=raw[:,:,:3].astype(float);target=front[:,:,:3].astype(float)
    diff=target-base
    # A bright cap or a side lock that the provider already drew behind the
    # fringe should not ride along as another outline. Solve the straight
    # alpha blend in actual RGB; stable hair pixels stay physically on the rear.
    need=np.where(diff>0,diff/np.maximum(1,255-base),-diff/np.maximum(1,base)).max(2)
    delta=np.abs(diff).max(2)
    depth=cv2.distanceTransform((front[:,:,3]>0).astype(np.uint8),cv2.DIST_L2,3)
    coverage=np.maximum.reduce([need,np.minimum(1,delta/55),np.minimum(1,depth/2.35)])
    skin=(target[:,:,0]-target[:,:,1]>12)&(target[:,:,0]>169)&(target[:,:,2]>122)
    coverage[skin]=np.maximum(need[skin],np.minimum(.78,delta[skin]/210))

    prior=donor[y:y+hh,x:x+ww]
    match=np.abs(target-prior[:,:,:3].astype(float)).max(2)
    pigment=np.clip((54-match)/40,0.,1.)*(prior[:,:,3]/255.)
    # The Flash fringe is an independent, transparent observation of hair.
    # A very similar-colored patch of skin is not an opaque moving hair edge.
    # Keep cross-registered source ink where necessary for neutral fidelity.
    coverage=np.maximum(need,np.minimum(coverage,pigment+(1-pigment)*np.minimum(1.,delta/165.)))
    root_index=next((i for i,p in enumerate(parts) if p['id']=='registered-hair-root'),None)
    if root_index is not None:
        crown=Image.new('L',(w,h))
        rect=parts[root_index]['rect']
        crown.paste(Image.fromarray(rasters[root_index][:,:,3]),(rect['left'],rect['top']))
        rooted=cv2.erode(np.asarray(crown),np.ones((7,7),np.uint8))[y:y+hh,x:x+ww]/255.
        coverage=np.maximum(need,coverage*(1-rooted))
        irises=[p['rect'] for p in parts if 'iris' in p['tags']]
        if len(irises)==2:
            cx,eye_y=np.mean([(r['left']+r['width']*.5,r['top']+r['height']*.5) for r in irises],axis=0)
            sep=abs(np.diff([r['left']+r['width']*.5 for r in irises])[0])
            rows,cols=np.indices((hh,ww));outer=(rows+y<eye_y-.92*sep)|(np.abs(cols+x-cx)>sep)
            stable=outer&(np.asarray(crown)[y:y+hh,x:x+ww]==255)
            front[:,:,3][stable]=0
            support &= ~stable
    a=np.ceil(coverage*255).clip(0,255)
    foreground=np.rint(base+diff*255/np.maximum(a,1)[:,:,None]).clip(0,255)
    front[:,:,:3][support]=foreground[support].astype(np.uint8)
    front[:,:,3][support]=a[support].astype(np.uint8)


def main(directory):
    config=json.loads((directory/'input.json').read_text())
    source=read_image(config['sourcePath'])
    H,W=source.shape[:2]
    regions=read_regions(config.get('regions',[]),W,H)
    parts=[]
    rasters=[]
    records=[]
    notes=[]
    shapes=[]
    for layer in config['layers']:
        with Image.open(directory/layer['file']) as im:
            shapes.append(im.size)
    scales=sorted({1., W/max((w for w,h in shapes),default=W), H/max((h for w,h in shapes),default=H)})

    def add(identifier, name, rgba, x, y, tags=(), origin='generated', reference=False, reason=None):
        part=dict(id=identifier,name=name,rect=dict(left=x,top=y,width=rgba.shape[1],height=rgba.shape[0]),
                  tags=list(tags),origin=origin,reference=reference,visible=not reference)
        if reason:
            part['occlusion']={'status':'inferred_unreviewed','note':reason}
        if tags and ('closed' in tags and 'eye' in tags or 'raised' in tags):
            part['visible']=False
            part['variant']={'type':'switch','parameter':'ParamWave' if 'raised' in tags else
                             ('ParamEyeLOpen' if 'left' in tags else 'ParamEyeROpen'),'switch_id':1 if 'raised' in tags else 0}
        if 'mouth' in tags and 'open' in tags:
            part.update(visible=False,variant={'type':'switch','parameter':'ParamMouthOpenY','switch_id':1})
        parts.append(part)
        rasters.append(rgba)

    observed=extract_face_details(source,config.get('regions',[]))
    boxed=place_boxed_layers(source,config['layers'],directory,read_image,observed)
    body=None
    original_observed=observed
    if boxed:
        placed,registration=boxed
        neck=extract_neck_plate(source,config.get('regions',[]))
        extended=extend_observed_lids(source,observed,placed,config.get('repairCriteria',[]))
        head=split_registered_head(source,placed,extended,neck,config.get('repairCriteria',[]))
        wave_box=regions.get('gesture:wave:rest')
        if head and wave_box:
            body=build_source_body(source,config.get('regions',[]),source_owner(head,(H,W)),
                source_owner(neck,(H,W)),placed['body']['rgba'],wave_box,rest_arm(source,wave_box))
        if body:
            observed=extended
            records.extend(registration)
            stacking=body['parts']+[head[0],neck[0],head[1],*neck[1:],*head[2:]]
            for item in stacking:
                semantic=item['semantic']
                add('registered-'+semantic.replace(':','-'),semantic,item['rgba'],item['x'],item['y'],
                    semantic.split(':'),item['origin'],reason=item['note'])
                if item.get('variant'):
                    parts[-1].update(visible=item['visible'],variant=item['variant'])
    raw=[] if body else config['layers']
    for number,layer in sorted(enumerate(raw),key=lambda item:(item[1].get('z') if isinstance(item[1].get('z'),int) else item[0])):
        image=read_image(directory/layer['file'])
        entry={'id':layer['id'],'registered':False}
        records.append(entry)
        if known_semantic(layer.get('label'))=='gesture:wave:raised':
            match=registered_wave(source,image,regions.get('gesture:wave:rest'))
            if match:
                rgba,(x,y,_,_)=match
                entry.update(registered=True,method='observed-shoulder')
                add(layer['id'],'Raised greeting sleeve, arm and hand',rgba,x,y,['gesture','wave','raised'],
                    reason='Alternate pose matched to the observed shoulder and sleeve; inspect gesture and anatomy.')
            else:
                add(layer['id'],'Unregistered proposed wave',image,0,0,reference=True)
                notes.append('Proposed wave has no verified shoulder connection.')
            continue
        if image.shape==source.shape and np.array_equal(image,source):
            entry['verifiedFullSourceReference']=True
            add(layer['id'],'Full-source comparison',image,0,0,reference=True)
            continue
        # An opaque provider base is retained for review only. It cannot become a movable body layer.
        opaque=image[:,:,3].min()==255
        if opaque and image.shape==source.shape:
            alpha=source[:,:,3:4].astype(np.float32)/255
            flattened=source[:,:,:3]*alpha+255*(1-alpha)
            error=np.abs(image[:,:,:3]-flattened)
            if error.mean()<1.25 and np.percentile(error,99)<5:
                entry['verifiedFullSourceReference']=True
        fit=None if opaque else match_layer(source,image,scales)
        if fit is None:
            add(layer['id'],layer.get('label') or f'Provider layer {number+1}',image,0,0,reference=True,
                reason='No unique source-space placement was established; excluded from default composition.')
            continue
        ratio,x,y,scale,rgba,matched,raw_box=fit
        h,w=rgba.shape[:2]
        original=source[y:y+h,x:x+w]
        rgba[:,:,:3][matched]=original[:,:,:3][matched]
        entry.update(registered=True,matchingFraction=round(ratio,5),sourcePixelsRestored=int(matched.sum()),
                     sourceFromProvider=[scale,0,x-raw_box[0]*scale,0,scale,y-raw_box[1]*scale])
        semantic=known_semantic(layer.get('label'))
        if not semantic and not layer.get('observedOnSheet'):
            semantic=overlay_semantic((x,y,w,h),regions)
        add(layer['id'],semantic or f'Provider layer {number+1}',rgba,x,y,(semantic or '').split(':') if semantic else (),
            reason='Generated occluded surfaces retained; only color-matched observed pixels restored from the source.')

    if config.get('classificationSheet') and any(r['registered'] for r in records) and all(r['registered'] or r.get('verifiedFullSourceReference') for r in records):
        # The overview has a common source pose and isolated, enlarged registered
        # pixels. No inferred/detail sprites are shown to the coarse classifier.
        entries=[('SOURCE',source,None)]+[(p['id'],rgba,p['rect']) for p,rgba in zip(parts,rasters) if not p['reference']]
        cols=min(4,len(entries));cell=(300,222)
        sheet=Image.new('RGB',(cell[0]*cols,cell[1]*math.ceil(len(entries)/cols)),(235,235,235))
        draw=ImageDraw.Draw(sheet)
        for i,(label,rgba,rect) in enumerate(entries):
            xx=(i%cols)*cell[0];yy=(i//cols)*cell[1]
            draw.text((xx+4,yy+3),label,fill=(20,20,20))
            im=Image.fromarray(rgba)
            if rect:
                thumb=Image.new('RGBA',(W,H))
                thumb.alpha_composite(im,(rect['left'],rect['top']))
                thumb.thumbnail((118,190))
                sheet.paste(thumb,(xx,yy+21),thumb.getchannel('A'))
                nonempty=im.getbbox()
                if nonempty:im=im.crop(nonempty)
                scale=min(172/im.width,190/im.height)
                im=im.resize((max(1,round(im.width*scale)),max(1,round(im.height*scale))),
                             Image.Resampling.NEAREST if scale>=1 else Image.Resampling.LANCZOS)
                dx=120
            else:
                im.thumbnail((286,190));dx=4
            sheet.paste(im,(xx+dx,yy+21),im.getchannel('A'))
        sheet.save(directory/'layer-sheet.png')

    owned=np.zeros((H,W),bool)
    present={':'.join(p['tags']) for p in parts if not p['reference']}
    for semantic,box in regions.items():
        # A visible line/pigment or accessory may be isolated locally. Off-image hands,
        # hidden eyewhites, a mouth cavity and an alternate sleeve pose require real artwork.
        if semantic in present or not(semantic in ('appearance:chest_bow','gesture:wave:rest') or
            semantic.startswith(('brow:','eye:iris:','eye:lash:','mouth:line:'))):
            continue
        if semantic=='appearance:chest_bow':
            # A model observation box can cut a wing or include a small strip of
            # collar. Give the pointed side wings working space and keep the top
            # seam attached to the garment.
            x,y,w,h=box
            extra=max(1,round(w*.13))
            x0=max(0,x-extra); x1=min(W,x+w+extra)
            inset=max(0,round(h*.07))
            box=(x0,y+inset,x1-x0,h-inset)
        mask=(body['restMask'].copy() if body else rest_arm(source,box)) if semantic=='gesture:wave:rest' else segmented_detail(source,box)
        if mask is None:
            notes.append(f'{semantic}: ambiguous source mask; no material emitted')
            continue
        x,y,w,h=box
        owner=crop(owned,box)
        if int((owner&mask).sum())>.15*int(mask.sum()):
            notes.append(f'{semantic}: overlapping source features; no material emitted')
            continue
        if semantic=='appearance:chest_bow':
            # Include antialiased foreground outlines surrounding the narrow tails.
            mask=cv2.dilate(mask.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
        mask &= ~owner
        owner |= mask
        # Work on the real neighboring pixels, not on a tight isolated crop.
        pad=max(4,round(min(w,h)*.5))
        xx,yy=max(0,x-pad),max(0,y-pad)
        local=source[yy:min(y+h+pad,H),xx:min(x+w+pad,W)]
        stencil=np.zeros(local.shape[:2],np.uint8)
        stencil[y-yy:y-yy+h,x-xx:x-xx+w]=mask
        fill=cv2.inpaint(local[:,:,:3].copy(),stencil, min(7,max(2,min(w,h)//5)),cv2.INPAINT_TELEA)
        if semantic=='appearance:chest_bow':
            # Continue the neighboring fabric as a harmonic surface. This uses
            # the actual trim above, garment tones on each side and cloth below.
            values=local[:,:,:3].astype(np.float32)
            unknown=stencil.astype(bool)
            values[unknown]=fill[unknown]
            neighbors=np.array([[0,.25,0],[.25,0,.25],[0,.25,0]],np.float32)
            for _ in range(min(640,2*max(w,h)**2)):
                smooth=cv2.filter2D(values,-1,neighbors)
                delta=np.abs(values[unknown]-smooth[unknown]).max()
                values[unknown]=smooth[unknown]
                if delta<.018:
                    break
            # Extend a visible garment seam between both sides of the missing
            # bow. Align the two sampled profiles at their actual dark-to-light
            # transition so the trim does not smear down into the cloth.
            bx,by=x-xx,y-yy
            if bx>=4 and bx+w+4<=local.shape[1]:
                left=local[:,bx-4:bx,:3].mean(axis=1)
                right=local[:,bx+w:bx+w+4,:3].mean(axis=1)
                def seam(profile):
                    light=profile@np.array([.299,.587,.114])
                    start=max(1,by-h//3);end=min(len(light)-1,by+h//2)
                    delta=light[start+1:end+1]-light[start-1:end-1]
                    row=start+int(np.argmax(delta))
                    return row,float(np.max(delta))
                lrow,ld=seam(left);rrow,rd=seam(right)
                if min(ld,rd)>24 and abs(lrow-rrow)<h*.6:
                    for row,col in np.argwhere(unknown):
                        t=np.clip((col-bx+.5)/w,0.,1.)
                        edge=lrow*(1-t)+rrow*t
                        rel=row-edge
                        a=np.clip(round(lrow+rel),0,len(left)-1)
                        b=np.clip(round(rrow+rel),0,len(right)-1)
                        # Preserve the white/skin notch where it meets the neckline.
                        weight=min(1.,max(0.,(rel+1)/2))
                        values[row,col]=(1-weight)*values[row,col]+weight*((1-t)*left[a]+t*right[b])
                    interior=unknown.copy()
                    interior[:max(lrow,rrow)+3]=False
                    for _ in range(360):
                        smooth=cv2.filter2D(values,-1,neighbors)
                        values[interior]=smooth[interior]
            fill=np.rint(values).astype(np.uint8)
        fill=fill[y-yy:y-yy+h,x-xx:x-xx+w]
        original=crop(source,box)
        for part,rgba in zip(parts,rasters):
            if part['reference'] or not part['id'].startswith(('runninghub-layer-','registered-')):
                continue
            rect=part['rect']; px,py=rect['left'],rect['top']
            x0,y0=max(x,px),max(y,py)
            x1,y1=min(x+w,px+rgba.shape[1]),min(y+h,py+rgba.shape[0])
            if x0>=x1 or y0>=y1:
                continue
            patch=rgba[y0-py:y1-py,x0-px:x1-px]
            oy,ox=slice(y0-y,y1-y),slice(x0-x,x1-x)
            close=np.abs(patch[:,:,:3].astype(np.int16)-original[oy,ox,:3]).max(axis=2)<=18
            remove=mask[oy,ox]&close&(patch[:,:,3]>0)
            # Detachable image data belongs to exactly one foreground layer.
            if semantic=='gesture:wave:rest':
                # Reveal separately registered deeper layers when the resting limb is lifted.
                patch[:,:,3][remove]=0
            else:
                patch[:,:,:3][remove]=fill[oy,ox][remove]
        if semantic=='appearance:chest_bow':
            backing=rgba_crop(original,mask)
            backing[:,:,:3]=fill
            add('source-chest-bow-underlay','Cloth beneath chest bow',backing,x,y,['appearance','chest_bow','underlay'],'inpainted',
                reason='Local color-continuation inpainting from the same garment; inspect neckline and seams after removal.')
        add('source-'+semantic.replace(':','-'),semantic,rgba_crop(original,mask),x,y,semantic.split(':'),'segmented',
            reason='Observed source pigment isolated with a seeded color/edge mask; unseen anatomy is not supplied by this operation.')
    # Source eye/mouth pigment is separated only where observations support it.
    # Restore one common skin backing, keeping the registered fringe untouched.
    facial=[d for d in observed+inferred_closed_lids(original_observed)+inferred_speech_parts(source,observed)
            if d['semantic'] not in {':'.join(p['tags']) for p in parts if not p['reference']}]
    if facial:
        erase,fill=facial_backing(source,facial)
        if body:
            # Original eyes and lip pigment must lift off a clean skin plate.
            # The independent provider face supplies contiguous forehead/skin
            # shading where the submitted image contained a line or aperture.
            face=placed['face']['rgba']
            supported=(erase>0)&(face[:,:,3]>230)
            fill[supported]=placed['face'].get('backingRgb',face[:,:,:3])[supported]
        for part,rgba in zip(parts,rasters):
            if part['reference'] or not part['id'].startswith(('runninghub-layer-','registered-')) or (part['tags'] and part['tags']!=['face']):
                continue
            x,y=part['rect']['left'],part['rect']['top'];h,w=rgba.shape[:2]
            original=source[y:y+h,x:x+w]
            comparable=np.abs(original[:,:,:3].astype(np.int16)-rgba[:,:,:3]).max(axis=2)<=18
            remove=comparable&(rgba[:,:,3]>0)&(erase[y:y+h,x:x+w]>0)
            rgba[:,:,:3][remove]=fill[y:y+h,x:x+w][remove]
        insert=next((i for i,p in enumerate(parts) if p['tags']==['hair','front']),len(parts))
        count=len(parts)
        for d in facial:
            tags=d['semantic'].split(':')
            if d['semantic'].startswith('mouth:line:') and d['origin']=='generated':
                tags.append('open')
            add('source-'+d['semantic'].replace(':','-'),d['semantic'],d['rgba'],int(d['x']),int(d['y']),
                tags,d['origin'],reason=d['note'])
        parts[insert:]=parts[count:]+parts[insert:count]
        rasters[insert:]=rasters[count:]+rasters[insert:count]
    forehead=[] if body else extract_forehead_patch(source,config.get('regions',[]))
    if forehead:
        under,tip=forehead
        x,y=tip['x'],tip['y']; hh,ww=tip['rgba'].shape[:2]
        for part,rgba in zip(parts,rasters):
            if not part['id'].startswith(('runninghub-layer-','registered-')) or part['reference']:
                continue
            px,py=part['rect']['left'],part['rect']['top']
            x0,y0=max(x,px),max(y,py)
            x1,y1=min(x+ww,px+rgba.shape[1]),min(y+hh,py+rgba.shape[0])
            if x0>=x1 or y0>=y1:
                continue
            local=rgba[y0-py:y1-py,x0-px:x1-px]
            raw=tip['rgba'][y0-y:y1-y,x0-x:x1-x]
            same=(raw[:,:,3]>0)&(np.abs(raw[:,:,:3].astype(np.int16)-local[:,:,:3]).max(2)<=18)
            local[:,:,3][same]=0
        insert=next((i for i,p in enumerate(parts) if p['tags']==['hair','front']),len(parts))
        count=len(parts)
        for d,tags in [(under,['face','detail','forehead','fringe-underpaint']),(tip,['hair','fringe','central-tip'])]:
            add('source-'+d['semantic'].replace(':','-'),d['semantic'],d['rgba'],int(d['x']),int(d['y']),tags,d['origin'],reason=d['note'])
        parts[insert:]=parts[count:]+parts[insert:count]
        rasters[insert:]=rasters[count:]+rasters[insert:count]
    if config.get('wave') and 'gesture:wave:raised' not in present:
        generated=read_image(directory/config['wave'])
        match=registered_wave(source,generated,regions.get('gesture:wave:rest'))
        if match:
            rgba,(x,y,_,_)=match
            add('generated-raised-arm','Raised greeting sleeve, arm and hand',rgba,x,y,['gesture','wave','raised'],
                reason='Generated hidden hand and alternate sleeve; check anatomy and continuity against the resting shoulder.')
        else:
            notes.append('Generated raised sleeve failed placement, transparency, or shoulder continuity; original edit retained outside Layout.')
    if body:soften_fringe(parts,rasters,source,placed['hair:front'].get('aligned',placed['hair:front']['rgba']))
    for i,(part,rgba) in enumerate(zip(parts,rasters)):
        name=f'part-{i}.png';Image.fromarray(rgba).save(directory/name);part['file']=name
    out=dict(parts=parts,canvas=dict(width=W,height=H),registration=records,notes=notes)
    (directory/'result.json').write_text(json.dumps(out,ensure_ascii=False))


if __name__=='__main__':
    main(Path(sys.argv[1]))
