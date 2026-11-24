from pathlib import Path
import json
import sys
from tempfile import TemporaryDirectory
import numpy as np
from PIL import Image

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'src/artwork'))
from facial_materials import extract_face_details, extract_forehead_patch, extract_neck_plate, remove_brow_backprint

# Public CC0 project fixture and observation boxes from actual 01, exclusively for this regression.
source=np.array(Image.open(root/'evidence/single-image-live2d/00/hachi-front.png').convert('RGBA'))
receipt=json.loads((root/'evidence/single-image-live2d/02/hachi-native-material-development/provenance.json').read_text())
regions=[region for region in receipt['regions'] if region['semantic'] in ('eye_l','eye_r')]

def check(im, observations):
    details=extract_face_details(im,observations)
    seen={d['semantic'] for d in details}
    assert seen=={part+':'+side for side in ('left','right') for part in
                  ('eye:white','eye:iris','eye:lash:upper','eye:lash:lower')}|{'mouth:closed'},seen
    erased=np.zeros(im.shape[:2],bool)
    for d in details:
        a=d['rgba'];h,w=a.shape[:2];x,y=d['x'],d['y'];actual=d['eraseMask']
        local=im[y:y+h,x:x+w]
        # All claimed observed pixels are exact RGBA samples. No duplicates between separately moving materials.
        assert np.array_equal(a[actual],local[actual])
        assert not np.any(erased[y:y+h,x:x+w]&actual)
        erased[y:y+h,x:x+w]|=actual
        if d['semantic'].startswith('eye:white:'):
            assert d['origin']=='inpainted' and np.count_nonzero((a[:,:,3]>0)&~actual)>15
        else:
            assert d['origin']=='segmented'
    recovered=im.copy();recovered[erased]=0
    for d in details:
        a=d['rgba'];h,w=a.shape[:2];x,y=d['x'],d['y'];m=a[:,:,3]>0
        recovered[y:y+h,x:x+w][m]=a[m]
    assert np.array_equal(im,recovered)
    return details

base=check(source,regions)
# Change size, location and iris pigmentation; no production coordinate or fixed brown color.
large=np.zeros((source.shape[0]+46,source.shape[1]+74,4),np.uint8)
for d in base:
    if d['semantic'].startswith('eye:iris:'):
        a=d['rgba'];h,w=a.shape[:2];x,y=d['x'],d['y']
        color=source[y:y+h,x:x+w,:3];mask=d['eraseMask']
        color[mask]=color[mask][:,::-1]
large[23:23+source.shape[0],37:37+source.shape[1]]=source
shifted=[]
for r in regions:
    l,t,rr,b=r['box'];ox,oy=37,23;w,h=source.shape[1],source.shape[0]
    shifted.append({'semantic':r['semantic'],'box':[(l*w+ox)/large.shape[1],(t*h+oy)/large.shape[0],
        (rr*w+ox)/large.shape[1],(b*h+oy)/large.shape[0]]})
check(large,shifted)
assert extract_face_details(np.full_like(source,255),regions)==[]
assert extract_face_details(source,[])==[]
assert extract_face_details(source,[regions[0],{**regions[0],'semantic':regions[1]['semantic']}])==[]

# A registered central tip and inferred backing can move independently, while
# retaining every source eye pixel and keeping strict full hair/face gates open.
def check_forehead(im, observations, eyes):
    backing,tip=extract_forehead_patch(im,observations)
    assert (backing['semantic'],tip['semantic'])==('forehead:fringe-underpaint','fringe:central-tip')
    assert backing['origin']=='inpainted' and not backing['erase'] and not backing['eraseMask'].any()
    assert tip['origin']=='segmented' and tip['erase'] and tip['eraseMask'].sum()>=50
    assert (backing['x'],backing['y'])==(tip['x'],tip['y'])
    h,w=tip['rgba'].shape[:2];x,y=tip['x'],tip['y']
    mask=tip['eraseMask']
    assert np.array_equal(tip['rgba'][:,:,3],backing['rgba'][:,:,3])
    assert np.array_equal(tip['rgba'][mask],im[y:y+h,x:x+w][mask])
    foreground=np.zeros(im.shape[:2],bool);foreground[y:y+h,x:x+w]=mask
    for eye in eyes:
        eh,ew=eye['rgba'].shape[:2];ex,ey=eye['x'],eye['y']
        assert not np.any(foreground[ey:ey+eh,ex:ex+ew]&eye['eraseMask'])
    exposed=im.copy();exposed[y:y+h,x:x+w][mask]=backing['rgba'][mask]
    assert np.sum((exposed!=im).any(2))>mask.sum()*.9
    exposed[y:y+h,x:x+w][mask]=tip['rgba'][mask]
    assert np.array_equal(exposed,im)
    return (x,y),mask
coords,front=check_forehead(source,regions,base)
coords2,other=check_forehead(large,shifted,extract_face_details(large,shifted))
assert coords2==(coords[0]+37,coords[1]+23) and np.array_equal(front,other)
assert extract_forehead_patch(np.full_like(source,255),regions)==[]
assert extract_forehead_patch(source,[])==[]
assert extract_forehead_patch(source,[regions[0],{**regions[0],'semantic':regions[1]['semantic']}])==[]

# A short upper overlap is sampled from the exposed neck. Clear the two
# source owners before rebuilding; jaw animation must reveal a single neck.
def check_neck(im,observations):
    neck,jaw=extract_neck_plate(im,observations)
    assert [neck['semantic'],jaw['semantic']]==['neck','face:detail:chin-overlap']
    cleared=im.copy()
    combined=np.zeros(im.shape[:2],bool)
    for part in (neck,jaw):
        x,y=part['x'],part['y'];h,w=part['rgba'].shape[:2]
        mask=part['eraseMask']
        assert part['erase'] and not (combined[y:y+h,x:x+w]&mask).any()
        combined[y:y+h,x:x+w]|=mask
        cleared[y:y+h,x:x+w,3][mask]=0
    x,y=neck['x'],neck['y'];h,w=neck['rgba'].shape[:2]
    visible=neck['eraseMask']
    assert visible.sum()>100 and np.array_equal(neck['rgba'][visible],im[y:y+h,x:x+w][visible])
    gx,gy=jaw['x']-x,jaw['y']-y;gh,gw=jaw['rgba'].shape[:2]
    # Old masks kept only fully opaque skin, leaving holes in the lifted chin.
    underneath=neck['rgba'][gy:gy+gh,gx:gx+gw,3][jaw['eraseMask']]
    assert len(underneath)>100 and (underneath>=150).mean()>.99
    partial=im[y:y+h,x:x+w,3]
    assert np.any((partial>0)&(partial<255)&combined[y:y+h,x:x+w])
    out=Image.fromarray(cleared)
    for part in (neck,jaw):
        out.alpha_composite(Image.fromarray(part['rgba']),(part['x'],part['y']))
    assert np.array_equal(np.asarray(out),im)
    return neck
neck=check_neck(source,regions);other=check_neck(large,shifted)
assert (other['x']-neck['x'],other['y']-neck['y'])==(37,23)
assert np.array_equal(other['rgba'],neck['rgba'])
assert extract_neck_plate(np.full_like(source,255),regions)==[]
assert extract_neck_plate(source,[])==[]

# The soft edge and the dark fringe on the skin must travel with the brow.
# Moving the brow leaves clean skin and preserves the exact neutral composite.
with TemporaryDirectory() as temp:
    folder=Path(temp)
    clean=[244,210,182,255]
    skin=np.full((25,28,4),clean,np.uint8)
    skin[11,8:18]=[58,67,69,255]
    skin[12,8:18]=[151,145,137,255]
    skin[15,8:18]=[173,131,112,255]
    brow=np.zeros((2,10,4),np.uint8)
    brow[0,:]=[61,71,73,255]
    brow[1,:]=[61,71,73,80]
    Image.fromarray(skin).save(folder/'face.png')
    Image.fromarray(brow).save(folder/'brow.png')
    parts=[{'id':'face','tags':['face'],'rect':{'left':10,'top':14,'width':28,'height':25}},
           {'id':'brow','tags':['brow'],'rect':{'left':18,'top':25,'width':10,'height':2}}]
    original=Image.fromarray(skin)
    original.alpha_composite(Image.fromarray(brow),(8,11))
    assert remove_brow_backprint(folder,parts)==20
    backing=Image.open(folder/'face.png')
    assert np.all(np.asarray(backing)[11:13,8:18]==clean)
    assert np.array_equal(np.asarray(backing)[15],skin[15])
    bounds=parts[1]['rect']
    backing.alpha_composite(Image.open(folder/'brow.png'),(bounds['left']-10,bounds['top']-14))
    assert backing.tobytes()==original.tobytes()
