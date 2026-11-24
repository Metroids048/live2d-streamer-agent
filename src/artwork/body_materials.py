"""Build source-owned body layers, revealing registered clothing beneath a moving limb."""
import cv2
import numpy as np


def _part(name,rgba,mask,origin,note):
    x,y,w,h=cv2.boundingRect(mask.astype(np.uint8))
    if not w or not h:
        return None
    pixels=rgba[y:y+h,x:x+w].copy()
    pixels[:,:,3][~mask[y:y+h,x:x+w]]=0
    return dict(semantic=name,rgba=pixels,x=x,y=y,origin=origin,note=note,visible=True)


def _leg_parts(source,body,cx):
    """Trace two isolated lower limbs upward to their observed hem transitions."""
    top=np.nonzero(body)[0]
    if not len(top):return []
    height=top.max()-top.min()+1
    row=int(top.min()+.76*height)
    runs=np.flatnonzero(np.diff(np.r_[False,body[row],False]))
    bands=[(a,b) for a,b in runs.reshape(-1,2) if b-a>.015*height]
    if len(bands)!=2 or not bands[0][1]<cx<bands[1][0]:
        return []
    light=cv2.cvtColor(source[:,:,:3],cv2.COLOR_RGB2GRAY).astype(float)
    yy,xx=np.indices(body.shape);out=[]
    for side,(a,b) in zip(('right','left'),bands):
        envelope=np.zeros_like(body);width=b-a;center=(a+b)//2
        # Follow each isolated standing leg up to where its silhouette joins
        # the garment. A color match alone also selects folds in a brown skirt.
        for y in range(row,top.min(),-1):
            xs=np.flatnonzero(np.diff(np.r_[False,body[y],False])).reshape(-1,2)
            choices=[(l,r) for l,r in xs if l<=center<r]
            if not choices: return []
            l,r=choices[0]
            if r-l>width*1.65 or r-l<width*.40:
                break
            envelope[y,l:r]=True
            center=(l+r)//2
            width=.85*width+.15*(r-l)
        else: return []
        join=y
        if not top.min()+.20*height<join<row-height*.07:
            return []
        bottom=join+1
        ll,rr=np.where(envelope[bottom])[0][[0,-1]]
        radius=max(3,round(width*.42))
        for x in range(ll,rr+1):
            ys=np.arange(max(2,join-radius),min(row,join+radius))
            valid=body[ys,x]&body[ys+2,x]
            score=np.abs(light[ys-2,x]-light[ys+2,x])-.8*np.abs(ys-join)
            if not valid.any():continue
            edge=int(ys[np.argmax(np.where(valid,score,-1e5))])+1
            envelope[max(0,join-radius):bottom+radius,x]=False
            envelope[edge:bottom+radius,x]=body[edge:bottom+radius,x]
        envelope[row:]=((xx[row:]<cx) if side=='right' else (xx[row:]>cx))
        isolated=envelope&body
        n,ids,stats,_=cv2.connectedComponentsWithStats(isolated.astype(np.uint8))
        if n<2:return []
        out.append(('leg:'+side,ids==(1+int(np.argmax(stats[1:,cv2.CC_STAT_AREA])))))
    return out


def build_source_body(source,observed_regions,head_ownership,neck_ownership,coarse_body,wave_box,rest_mask):
    """coarse_body must be the registered no-arm garment on the source RGBA canvas.

    Returns disjoint cropped, source-positioned parts, and the original resting
    limb's revised ownership within wave_box. Reject inconsistent registration.
    """
    if coarse_body is None or coarse_body.shape!=source.shape or wave_box is None or rest_mask is None:
        return None
    H,W=source.shape[:2];rx,ry,rw,rh=wave_box
    if rest_mask.shape!=(rh,rw) or not (0<=rx<rx+rw<=W and 0<=ry<ry+rh<=H):
        return None
    owned=(source[:,:,3]>0)&~head_ownership&~neck_ownership
    if not np.any(owned):
        return None
    yy,xx=np.indices(owned.shape)
    body=coarse_body
    # Confirm coarse clothing against real unobscured source clothes at this
    # placement. Never treat an arbitrary nearby garment as a hidden backing.
    common=owned&(body[:,:,3]>230)&(source[:,:,3]>230)
    difference=np.abs(body[:,:,:3].astype(np.int16)-source[:,:,:3]).max(2)
    if common.sum()<100 or (difference[common]<32).mean()<.65:
        return None
    rest=np.zeros_like(owned);rest[ry:ry+rh,rx:rx+rw]=rest_mask
    lab=cv2.cvtColor(source[:,:,:3],cv2.COLOR_RGB2LAB).astype(float)
    arm=rest & (yy>ry+rh*.60)&(yy<ry+rh*.80)&(source[:,:,3]>220)
    if arm.sum()<12:return None
    tone=np.median(lab[arm],axis=0)
    skin=np.linalg.norm(lab-tone,axis=2)<62
    # Work strictly below observed bare skin. The painted donor still has the
    # original two orange sleeves and must never become a layer in the pose.
    observed=skin&rest&(yy>ry+rh*.28)
    counts=observed.sum(1)
    span=np.flatnonzero(counts>max(4,rw*.14))
    if not len(span):return None
    skin_top=span[0]
    at_waist=(yy>skin_top+max(4,round(.07*rh)))&(yy<ry+rh)
    # Carry the source arm-side seam into rest, replacing it in the raised
    # pose by the actual generated cloth. Keep the band's native outer edge.
    spread=cv2.dilate(rest.astype(np.uint8),np.ones((5,5),np.uint8)).astype(bool)
    inner=(body[:,:,3]>220)&(source[:,:,3]>160)
    rest|=spread&at_waist&inner&(difference>22)&(xx>=rx)&(xx<rx+rw)
    # The reveal is its own ParamWave switch, fixed to the body. Sharing its
    # half-transparent boundary with the resting limb would change the default.
    under=rest&at_waist&(body[:,:,3]>0)
    if under.sum()<rw*rh*.009:
        return None
    # The opposite forearm is absent on the donor. Its real silhouette, skin
    # and cuff contact have to survive separately on default and wave poses.
    torso=owned&(yy>=ry+rh*.50)&(yy<=ry+rh*.78)
    centers=np.nonzero(torso&(body[:,:,3]>180))[1]
    if not len(centers):return None
    cx=int(np.median(centers))
    opposite=(xx<cx-rw*.34) if rx+rw*.5>cx else (xx>cx+rw*.34)
    proposal=skin & owned & opposite & (yy>ry+rh*.34)&(yy<ry+rh*1.09)
    n,ids,stats,_=cv2.connectedComponentsWithStats(proposal.astype(np.uint8))
    options=[i for i in range(1,n) if stats[i,cv2.CC_STAT_HEIGHT]>rh*.32 and stats[i,cv2.CC_STAT_WIDTH]<rw*.70]
    if not options:return None
    other=ids==max(options,key=lambda i:stats[i,cv2.CC_STAT_AREA])
    grow=cv2.dilate(other.astype(np.uint8),np.ones((5,5),np.uint8)).astype(bool)
    other |= grow&owned&((body[:,:,3]<100)|(difference>46))
    # Source every visible default pixel from the input. The donor contributes
    # only at newly exposed pixels behind the isolated arms.
    facing='right' if rx+rw*.5>cx else 'left'
    clothes=owned&~rest&~other
    legs=_leg_parts(source,clothes,cx)
    leg_mask=np.zeros_like(clothes)
    for _,mask in legs:leg_mask|=mask
    # Trace the visible upper seam of the belt/skirt near the center, allowing
    # curvature across the torso. If ambiguous, keep the real torso intact.
    low=max(2,round(ry+rh*.58));high=min(H-2,round(ry+rh*.84))
    if high<=low:return None
    gradient=np.linalg.norm(lab[2:]-lab[:-2],axis=2)
    margin=max(2,round(rw*.12))
    if not margin<=cx<W-margin:return None
    signal=gradient[low-1:high-1,cx-margin:cx+margin].mean(1)
    center=low+int(np.argmax(signal))
    if signal.max()<14:return None
    seam=np.full(W,center,int)
    for direction in (-1,1):
        pos=center
        for x in range(cx,W if direction>0 else -1,direction):
            if not clothes[pos,x]:
                continue
            near=np.arange(max(low,pos-2),min(high,pos+3))
            score=gradient[near-1,x]-6*np.abs(near-pos)
            if score.max()>6:
                pos=near[np.argmax(score)]
            seam[x]=pos
    lower=clothes&~leg_mask&(yy>=seam[None,:])
    upper=clothes&~leg_mask&~lower
    # The two wings of a waist accessory may reach above its central belt.
    # Use actual donor wing colors against this shirt's observed tones to
    # keep a wing projecting from the flank with the lower garment.
    wing=under&(body[:,:,3]>220)&(yy<center)
    shirt=upper&(abs(xx-cx)<margin)&(yy<center-rh*.05)&(yy>center-rh*.20)
    if min(wing.sum(),shirt.sum())>12:
        wing_lab=cv2.cvtColor(body[:,:,:3],cv2.COLOR_RGB2LAB)
        def distance_to(samples):
            anchors=np.percentile(samples,[15,50,85],axis=0)
            return np.min([np.linalg.norm(lab-v,axis=2) for v in anchors],axis=0)
        wd=distance_to(wing_lab[wing]);sd=distance_to(lab[shirt])
        flank=(abs(xx-cx)>rw*.41)&(yy>center-rh*.20)&upper
        lifted=flank&(wd+8<sd)
        upper &= ~lifted
        lower |= lifted
    n,ids,stats,_=cv2.connectedComponentsWithStats(upper.astype(np.uint8))
    if n>1:
        main=ids==(1+int(np.argmax(stats[1:,cv2.CC_STAT_AREA])))
        # Earlier detached fragments at head height stay with upper ownership.
        sash=(upper&~main)&(yy>center-rh*.23)
        lower|=sash
        upper &= ~sash
    reveal=_part('body:underlay:waist',body,under,'generated','Actual registered garment painted behind the moving arm; the old sleeve is excluded.')
    reveal.update(visible=False,variant={'type':'switch','parameter':'ParamWave','switch_id':1})
    parts=[reveal]
    for name,mask in legs:
        parts.append(_part(name,source,mask,'segmented','Observed stocking and shoe under the skirt.'))
    parts.extend([_part('lower-body',source,lower,'segmented','Observed skirt and sash.'),
                  _part('upper-body',source,upper,'segmented','Observed garment and shoulders with resting arm removed.'),
                  _part('arm:'+facing,source,other,'segmented','Observed opposite forearm from cuff to dress; retained in either pose.')])
    return dict(parts=[p for p in parts if p],restMask=rest[ry:ry+rh,rx:rx+rw])
