"""Fit a named, boxed Flash portrait to the submitted, alpha-isolated source.

Use the provider's actual forehead, rear hair and concealed eyebrows below the
visible source silhouette. Parts incompatible with the observed source are
individually replaced, never collected as additional drawable layers.
"""
import cv2
import numpy as np


ROLES={'衣身及配饰':'body','后发':'hair:back','脸部底图':'face','颈部':'neck','口腔':'mouth:open',
       '嘴唇':'lips','鼻':'nose','前发':'hair:front',
       **{cn+s:key+':'+side for cn,side in [('左','left'),('右','right')]
          for s,key in [('虹膜','eye:iris'),('眼白','eye:white'),('眼皮','eye:lash'),('眉','brow')]}}


def patch(semantic,pixels,owner,note,origin):
    x,y,w,h=cv2.boundingRect((pixels[:,:,3]>0).astype(np.uint8))
    return dict(semantic=semantic,x=x,y=y,rgba=pixels[y:y+h,x:x+w].copy(),
                eraseMask=owner[y:y+h,x:x+w].copy(),note=note,origin=origin)


def source_owner(parts,shape):
    owner=np.zeros(shape,bool)
    for p in parts:
        x,y=p['x'],p['y'];m=p['eraseMask'];h,w=m.shape
        owner[y:y+h,x:x+w]|=m
    return owner


def place_boxed_layers(source, layers, directory, read_image, details):
    names=[ROLES.get(layer.get('label')) for layer in layers]
    # This group promises a complete face/head breakdown. An unknown named
    # part or two raw layers claiming the same role must go to review.
    anonymous=[i for i,n in enumerate(names) if n is None]
    if len(anonymous)!=1 or set(names)-{None}!=set(ROLES.values()) or len(set(names))!=len(names):return None
    bg=read_image(directory/layers[anonymous[0]]['file'])
    if bg[:,:,3].min()!=255 or bg[:,:,:3].min()<242 or bg[:,:,:3].std()>2:return None
    H,W=source.shape[:2];ch,cw=bg.shape[:2]
    if abs((W/H)/(cw/ch)-1)>.015:return None
    # All provider boxes refer to the same external canvas, despite each tile
    # being exported at a different resolution.
    placed={};records=[]
    for layer,role in zip(layers,names):
        if role is None:
            records.append(dict(id=layer['id'],registered=False,verifiedBackgroundOnly=True,method='opaque-neutral-background-reference'))
            continue
        box=layer.get('box') or {};absolute=box.get('absolute');norm=box.get('normalized')
        if not isinstance(absolute,list) or len(absolute)!=4 or not isinstance(norm,list) or len(norm)!=4:return None
        coords=np.asarray(absolute,float);normalized=np.asarray(norm,float)
        ratios=coords/[cw,ch,cw,ch]
        if not np.isfinite(ratios).all() or not (0<=ratios.min() and ratios.max()<=1) or np.max(abs(ratios*1000-normalized))>3:return None
        x,y,xx,yy=np.rint(ratios*[W,H,W,H]).astype(int)
        if not (0<=x<xx<=W and 0<=y<yy<=H):return None
        raw=read_image(directory/layer['file'])
        if not 0<np.mean(raw[:,:,3]>=160)<.99:return None
        rgba=np.zeros_like(source);rgba[y:yy,x:xx]=cv2.resize(raw,(xx-x,yy-y),interpolation=cv2.INTER_AREA)
        solid=rgba[:,:,3]>150
        if not solid.any():return None
        mask=solid&(source[:,:,3]>=150)
        near=(abs(rgba[:,:,:3].astype(np.int16)-source[:,:,:3]).max(2)<=30)&mask
        overlap=mask.sum()/solid.sum();ratio=near.sum()/solid.sum()
        if overlap<(.83 if role in ('hair:front','hair:back','body') else .80):return None
        if role in ('body','hair:front') and ratio<.66:return None
        placed[role]={'rgba':rgba,'rect':[int(x),int(y),int(xx),int(yy)],'id':layer['id']}
        records.append(dict(id=layer['id'],registered=True,semantic=role,method='provider-box-with-observed-source-anchors',
            sourceRect=[int(x),int(y),int(xx),int(yy)],sourceCoverage=round(float(overlap),4),colorMatchFraction=round(float(ratio),4)))
    # Visible bilateral irises and the closed lip supply independent landmarks.
    observed={p['semantic']:p for p in details}
    for key in ('eye:iris:left','eye:iris:right','mouth:closed'):
        if key not in observed:return None
        p=observed[key];xx=p['x']+p['rgba'].shape[1]/2;yy=p['y']+p['rgba'].shape[0]/2
        a,b,c,d=placed['lips' if key=='mouth:closed' else key]['rect']
        if not a-2<=xx<=c+2 or not b-2<=yy<=d+2:return None
    return placed,records


def fitted_face_skin(source, placed, details, repair_criteria):
    """Continue measured complexion across missing eye skin on the registered plate."""
    x,y,xx,yy=placed['face']['rect']
    donor=placed['face']['rgba'][y:yy,x:xx]
    raw=source[y:yy,x:xx]
    rgb=raw[:,:,:3].astype(np.float32);r,g,b=rgb.transpose(2,0,1)
    valid=(donor[:,:,3]>205)&(raw[:,:,3]==255)&(r>180)&(b>125)&(r-g>7)&(r-b<104)&(g-b<38)&(g-b>-4)
    for side in ('left','right'):
        eye=[p for p in details if p['semantic'].startswith('eye:') and p['semantic'].endswith(':'+side)]
        occupied=source_owner(eye,source.shape[:2])[y:yy,x:xx].astype(np.uint8)
        points=cv2.findNonZero(occupied)
        if points is not None:
            cv2.fillConvexPoly(occupied,cv2.convexHull(points),1)
            valid &= cv2.dilate(occupied,np.ones((3,3),np.uint8))==0
    xs=placed['nose']['rect'];valid[max(0,xs[1]-y-1):xs[3]-y+1,max(0,xs[0]-x-1):xs[2]-x+1]=False
    if valid.sum()<24:return None
    residual=rgb-donor[:,:,:3].astype(float)
    # Coarse estimates follow the real donor's forehead gradient. Fine
    # estimates take their boundary color only from source complexion, never
    # from the black eyelid, iris, or a silver bang across a sampling row.
    correction=np.zeros_like(residual)
    weights=valid.astype(np.float32)
    for sigma in (max(5,(xx-x)*.17),max(2,(xx-x)*.057),1.45):
        support=cv2.GaussianBlur(weights,(0,0),sigma)
        sums=cv2.GaussianBlur(residual*weights[:,:,None],(0,0),sigma)
        blend=np.minimum(1,support/.19)[:,:,None]
        correction=correction*(1-blend)+blend*sums/np.maximum(support,.0001)[:,:,None]
    # A blink exposes skin sampled close to the original rim. A fully exposed
    # forehead is lit by the broad plate, not by the sharp cast marks of the
    # original bangs. Fade out that high-frequency shadow well before the lid.
    eye_parts=[p for p in details if p['semantic'].startswith('eye:iris:')]
    eye_y=np.mean([p['y']+p['rgba'].shape[0]/2 for p in eye_parts])-y
    separation=abs(np.diff([p['x']+p['rgba'].shape[1]/2 for p in eye_parts])[0])
    forehead_smoothing=.23 if 'occlusion-completion' in repair_criteria else .19
    sigma=max(2.5,separation*forehead_smoothing)
    weight=(donor[:,:,3]>180).astype(float)
    smoothed=cv2.GaussianBlur(correction*weight[:,:,None],(0,0),sigma)/np.maximum(
        .0001,cv2.GaussianBlur(weight,(0,0),sigma))[:,:,None]
    fade=np.clip((eye_y+separation*.08-np.arange(yy-y))/(separation*.37),0,1)
    fade=(fade*fade*(3-2*fade))[:,None,None]
    correction=correction*(1-fade)+smoothed*fade
    result=placed['face']['rgba'][:,:,:3].copy()
    result[y:yy,x:xx]=np.rint(np.clip(donor[:,:,:3]+correction,0,255)).astype(np.uint8)
    return result


def extend_observed_lids(source, details, placed, repair_criteria=()):
    """Own the whole observed ocular rim, including antialiasing outside the ink."""
    H,W=source.shape[:2];result=list(details)
    backing=fitted_face_skin(source,placed,details,repair_criteria)
    if backing is None:return details
    placed['face']['backingRgb']=backing
    for side in ('left','right'):
        eye=[p for p in details if p['semantic'].startswith('eye:') and p['semantic'].endswith(':'+side)]
        if not eye:continue
        mask=source_owner(eye,(H,W))
        points=cv2.findNonZero(mask.astype(np.uint8))
        if points is None:continue
        x,y,w,h=cv2.boundingRect(points)
        aperture=np.zeros((H,W),np.uint8)
        cv2.fillConvexPoly(aperture,cv2.convexHull(points),1)
        margin=max(1,round(w*(.12 if 'half-blink' in repair_criteria else .10)))
        aperture=cv2.dilate(aperture,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*margin+1,2*margin+1))).astype(bool)
        fringe=placed['hair:front']['rgba']
        pigment=source[:,:,:3].astype(float)
        original_hair=(fringe[:,:,3]>90)&(np.abs(pigment-fringe[:,:,:3]).max(2)<42)&(pigment[:,:,0]-pigment[:,:,1]<18)
        # A gray eyelash may match an isolated pixel of the gray donor fringe.
        # Material belonging to hair must have local support from that strand.
        supported_hair=cv2.boxFilter(original_hair.astype(np.float32),-1,(3,3))>=(
            .62 if 'half-blink' in repair_criteria else .50)
        original_hair &= supported_hair
        base=backing.astype(float);delta=pigment-base
        contrast=np.abs(delta).max(2)
        extra=aperture & ~mask & ~original_hair & (source[:,:,3]>=252)&(contrast>7)
        minimum=np.where(delta>0,delta/np.maximum(1,255-base),-delta/np.maximum(1,base)).max(2)
        a=np.ceil(255*np.maximum(minimum,np.minimum(1,contrast/126))).clip(1,255)
        ink=np.rint(np.clip(base+delta*255/a[:,:,None],0,255))

        for edge in ('upper','lower'):
            old=next((p for p in eye if p['semantic']=='eye:lash:'+edge+':'+side),None)
            if not old:continue
            expand=extra&(np.indices(extra.shape)[0] < y+h*.55)
            if edge=='lower':expand=extra&~expand
            owned=source_owner([old],(H,W))|expand
            pix=source.copy();pix[:,:,3]=np.where(owned,pix[:,:,3],0)
            pix[:,:,:3][owned]=ink[owned].astype(np.uint8)
            pix[:,:,3][owned]=(a[owned]*source[:,:,3][owned]/255).round().astype(np.uint8)
            if edge=='upper':
                # Only the actual dark upper lash travels down. A pale skin
                # crease or colored eye makeup should fade in place as the
                # eye shuts rather than descending as an opaque strip.
                original_edge=source_owner([old],(H,W))
                dark=-(delta@np.array([.299,.587,.114]))
                strength=np.where(original_edge,np.maximum(0,dark),0)
                valid=np.flatnonzero(strength.max(0)>8)
                if len(valid)>=max(5,w*.53):
                    axis=np.arange(W)
                    center=np.interp(axis,valid,np.argmax(strength[:,valid],axis=0))
                    peak=np.interp(axis,valid,strength[:,valid].max(0))
                    distance=np.abs(np.arange(H)[:,None]-center)
                    actual=owned&(distance<=max(1.1,h*.085))&(dark>=np.maximum(16,peak*.48))
                    if actual.sum()>=w*.65:
                        shade=owned&~actual
                        if shade.any():
                            tint=pix.copy();tint[:,:,3][~shade]=0
                            rim=patch('eye:rim:'+side,tint,shade,'Observed skin crease and eyelid color outside the darkest upper lash. Its opacity follows eye opening; skin does not travel with the lash.','segmented')
                            result.append({**rim,'erase':True})
                            owned=actual
                            pix[:,:,3][~owned]=0
            new=patch(old['semantic'],pix,owned,old['note']+' Observed eyelash ink and antialiasing, separated from lid skin.',old['origin'])
            result[next(i for i,p in enumerate(result) if p is old)]={**old,**new}
    return result


def align_fringe_edges(source, donor, backing, rect):
    """Register the supplied narrow ink/alpha boundaries before matting them."""
    x,y,xx,yy=rect
    src=source[y:yy,x:xx,:3].astype(np.float32)
    tile=donor[y:yy,x:xx]
    a=tile[:,:,3:4].astype(np.float32)/255
    ref=src.copy()
    under=backing[y:yy,x:xx].astype(np.float32)
    # Populate only the near-edge band from donor skin. The source eyes and
    # other observed landmarks are the fixed surroundings for local flow.
    band=cv2.dilate((a[:,:,0]>.03).astype(np.uint8),np.ones((7,7),np.uint8)).astype(bool)
    reliable=band&(under.max(2)>110)
    ref[reliable]=(tile[:,:,:3]*a+under*(1-a))[reliable]
    gray=lambda im:cv2.cvtColor(np.rint(im).clip(0,255).astype(np.uint8),cv2.COLOR_RGB2GRAY)
    flow=cv2.calcOpticalFlowFarneback(gray(src),gray(ref),None,.5,2,11,4,5,1.1,0)
    dy,dx=np.indices(tile.shape[:2],dtype=np.float32)
    fx=dx+flow[:,:,0].clip(-3,3);fy=dy+flow[:,:,1].clip(-3,3)
    nr=cv2.remap(tile[:,:,:3]*a,fx,fy,cv2.INTER_LINEAR)
    na=cv2.remap(a[:,:,0],fx,fy,cv2.INTER_LINEAR)
    out=donor.copy()
    out[y:yy,x:xx,:3]=np.rint(nr/np.maximum(.0001,na[:,:,None])).clip(0,255).astype(np.uint8)
    out[y:yy,x:xx,3]=np.rint(na*255).astype(np.uint8)
    return out


def arch_forehead(face, backing, rect, cx, cy, separation, repair_criteria):
    # A donor's tightly cropped rectangular forehead cannot be the hairline
    # when the fringe opens. Its skin and alpha are registered at the temples;
    # continue the concealed crown, easing the displacement to zero over the eyes.
    left,top,right,_=rect
    yy,xx=np.indices(face.shape[:2],dtype=np.float32)
    rx=max(1.,(right-left)*.5)
    distance=np.minimum(1.12,np.abs(xx-(left+right)*.5)/rx)
    lift=separation*((.34 if 'occlusion-completion' in repair_criteria else .28)*(1-distance**2)-.23*distance**3)
    hinge=cy-separation*.38
    sample=np.where(yy<hinge,hinge+(yy-hinge)*(hinge-top)/np.maximum(1.,hinge-(top-lift)),yy).astype(np.float32)
    return (cv2.remap(face,xx,sample,cv2.INTER_LINEAR),
            cv2.remap(backing,xx,sample,cv2.INTER_LINEAR),top-lift)


def fringe_root_weight(rows, eye_y, separation):
    weight=np.clip((eye_y-separation*.32-rows)/(separation*.57),0.,1.)
    return weight*weight*(3.-2.*weight)


def split_registered_head(source, placed, details, neckparts, repair_criteria=()):
    H,W=source.shape[:2];alpha=source[:,:,3]
    if not neckparts:return []
    observed={p['semantic']:p for p in details}
    irises=[observed['eye:iris:'+side] for side in ('left','right')]
    centers=[(p['x']+p['rgba'].shape[1]/2,p['y']+p['rgba'].shape[0]/2) for p in irises]
    d=abs(centers[0][0]-centers[1][0]);cx,cy=np.mean(centers,axis=0)
    if d<18 or abs(centers[0][1]-centers[1][1])>.14*d:return []
    front=placed['hair:front']['rgba'];rear=placed['hair:back']['rgba'];face=placed['face']['rgba']
    fx,fy,fx1,fy1=placed['hair:front']['rect'];ey,ex=np.indices(alpha.shape);dx=abs(ex-cx)/d
    if 'backingRgb' in placed['face']:
        front=align_fringe_edges(source,front,placed['face']['backingRgb'],(fx,fy,fx1,fy1))
        placed['hair:front']['aligned']=front
    # Include the source hair silhouette slightly beyond the provider box.
    # Exclude original neck/chin samples and low central collar pixels.
    nr=source_owner(neckparts,alpha.shape)
    head=(alpha>0)&(ex>=fx-d*.12)&(ex<fx1+d*.12)&(ey>=fy-d*.12)&(ey<fy1+d*.10)&~nr
    low=ey>max(p['y']+p['rgba'].shape[0] for p in neckparts if p['semantic'].startswith('face:'))-2
    head &= ~(low&(dx<.64))
    if head.sum()<5*d*d:return []
    rgb=source[:,:,:3].astype(float);r,g,b=rgb.transpose(2,0,1)
    hair_color_error=np.max(abs(rgb-front[:,:,:3]),2)
    within=(face[:,:,3]>60)
    within=cv2.dilate(within.astype(np.uint8),np.ones((5,5),np.uint8)).astype(bool)
    ocular=np.zeros_like(head)
    for p in details:
        if p['semantic'].startswith('eye:'):
            yy,xx=p['y'],p['x'];h,w=p['rgba'].shape[:2]
            ocular[yy:yy+h,xx:xx+w]|=p['rgba'][:,:,3]>0
    # Keep colour of exposed complexion and facial features. Fringe shape
    # uses the actual colors of this image: chromatic skin is not a grey bang.
    upper=ey<cy+.14*d
    skin=(r-g>max(9,d*.24))&(r>202)&(b>148)&(g-b<38)&(r-b>14)
    hair_good=(front[:,:,3]>140)&(hair_color_error<42)
    face_visible=head&within&(((skin&~hair_good)|ocular)|(~upper&(front[:,:,3]<104)&(dx<1.02)))
    # Separate the original antialiased jaw from the moving cheek margin.
    face_visible &= ((ey<cy+.54*d)|(dx<1-.49*np.maximum(0,(ey-cy)/d-.55)))
    # On the forehead reserve ambiguous cool strokes to the overlying hair.
    face_visible &= ~((ey<cy-.14*d)&~ocular&((r-g<18)|(r<205)))
    # Dark hair tips at jaw level and the mirrored yellow side locks are not
    # cheek pixels, even when the registered frontal-hair matte ends early.
    fits_face=np.abs(rgb-face[:,:,:3]).max(2)<49
    face_visible &= ocular | ((r>158)&(b>118)&(r-b<100)&((face[:,:,3]>150)|fits_face))
    # The diagonal shade under the bangs and the outline of each side lock
    # travel with the hair. The registered plate carries continuous skin below
    # them. Keep the whole measured eye aperture ahead of this ownership test.
    high=ey<cy-.09*d
    cheek=(dx>.59)&(ey>cy-.15*d)&(ey<cy+1.06*d)
    face_visible &= ocular | (~high & ~(cheek & (np.abs(rgb-face[:,:,:3]).max(2)>17)))
    # The remaining source pixels outside the original face outline belong to
    # the hair. Assign external hair ornaments and strands from the rear tile.
    hair=head&~face_visible
    prior=front[:,:,3].astype(float)/255
    forehead=(ey<cy-.11*d)&within&(dx<.95)&(r-g<22)
    front_visible=hair&((prior>.35)|forehead|within)&(alpha==255)
    # Outer side locks and cheek-side shadows have their own roots. A 4 px
    # fringe displacement should not also slide the entire hair silhouette.
    # Locate the observed grey-to-gold change at the temples. Fixed x/y
    # boundaries slice the diagonal forelock through its own grey highlights.
    colored=(r-b>34)&((g-b>21)|(b<116))
    side_seed=(colored&(dx>.49)&(ey>cy-.52*d))|(ey>cy+.18*d)
    sides=front_visible&side_seed
    # At the two red tips the source itself specifies which strand ends in
    # front. Pixels outside the Flash matte remain on the registered rear hair.
    rear_visible=hair&~front_visible
    # Hidden source-coloured AA must not double the exterior alpha. Inferred
    # drawables are permitted only beneath already opaque, owned source pixels.
    safe=(alpha==255)&head
    # In the narrow edge overlap, the provider's rear layer can also carry a
    # near-identical copy of the bangs. Restrict it to the genuinely hidden
    # cap / tips; the actual cleaned face paints above it in every state.
    back=rear.copy()
    back[:,:,3]=np.where(safe&~rear_visible,back[:,:,3],0)
    back[rear_visible]=source[rear_visible]
    fixed=fringe_root_weight(ey,cy,d)
    cap=(fixed>0)&front_visible&~sides
    crown=source.copy()
    crown[:,:,3]=np.where(cap,np.rint(fixed*alpha),0).astype(np.uint8)
    front_raster=source.copy();front_raster[:,:,3]=np.where(front_visible&~sides,alpha,0)
    # Underpaint the forehead with the real provider face plate. Its upper
    # hair shadow is fair to retain; original eyes/lips stay source-derived.
    plate=face.copy()
    if 'backingRgb' in placed['face']:
        plate,skin,hairline=arch_forehead(plate,placed['face']['backingRgb'],placed['face']['rect'],cx,cy,d,repair_criteria)
        # A fixed root ends at the curved hairline. Long shadows from the
        # former fringe should not remain painted on a fully exposed forehead.
        root_edge=np.clip((hairline+d*.12-ey)/max(1.,d*.07),0.,1.)
        border=np.clip((dx-.83)/.14,0.,1.)*np.clip((cy+.12*d-ey)/(.24*d),0.,1.)
        crown[:,:,3]=np.where(cap,np.rint(alpha*np.maximum(fixed*root_edge,border)),0).astype(np.uint8)
        plate[:,:,:3]=skin
        placed['face']['backingRgb']=skin
    plate[:,:,3]=np.where(safe&~face_visible,plate[:,:,3],0)
    # Avoid colouring the outside of the face from under separately owned hair
    # unless the front hair is fully opaque at that pixel in the neutral pose.
    plate[:,:,3][rear_visible|nr]=0
    plate[face_visible]=source[face_visible]
    out=[patch('hair:back',back,rear_visible,'Provider rear hair mapped by its canvas box; visible rear strands and ornaments restored in submitted image coordinates.','inpainted'),
         patch('face',plate,face_visible,'Original visible complexion and facial landmarks over the registered provider face plate; occluded forehead shading is provider-generated.','inpainted')]
    for side in ('left','right'):
        brow=placed['brow:'+side]['rgba'].copy()
        # Preserve the exact neutral face. An originally hidden brow may only
        # appear when the covering bangs are translated or deformed.
        exists=brow[:,:,3].sum()
        brow[:,:,3]=np.where(front_visible&(alpha==255),brow[:,:,3],0)
        if not exists or brow[:,:,3].sum()<exists*.40:return []
        out.append(patch('brow:'+side,brow,np.zeros_like(head),'Real provider-drawn eyebrow registered to the observed eye; only pixels concealed by neutral opaque bangs retained.','generated'))
    # Keep the nose an independent observational layer. Its registered box
    # is small, so preserve its whole original antialiased support.
    nx,ny,xx,yy=placed['nose']['rect'];nose=np.zeros_like(head)
    nose[ny:yy,nx:xx]=face_visible[ny:yy,nx:xx]
    if nose.any():
        pic=source.copy();pic[:,:,3]=np.where(nose,alpha,0)
        out.append(patch('nose',pic,nose,'Observed nose pigment and its antialiasing in the registered nose box.','segmented'))
        p=out[1];y0,x0=p['y'],p['x'];h,w=p['rgba'].shape[:2]
        local=nose[y0:y0+h,x0:x0+w]
        p['rgba'][:,:,:3][local]=face[y0:y0+h,x0:x0+w,:3][local]
        p['eraseMask'][local]=False
    for side,side_mask in [('left',sides&(ex>=cx)),('right',sides&(ex<cx))]:
        if side_mask.any():
            pic=source.copy();pic[:,:,3]=np.where(side_mask,alpha,0)
            out.append(patch('hair:side:'+side,pic,side_mask,'Visible side lock and cast shade separated from the central floating fringe.','segmented'))
    out.append(patch('hair:front',front_raster,front_visible&~sides,'Registered fringe retains observed hair and antialiasing below the fixed scalp.','segmented'))
    if cap.any():
        out.append(patch('hair:root',crown,np.zeros_like(head),'Stationary observed roots overlap the upper fringe. Only free strands move independently from the scalp.','segmented'))
    return out
