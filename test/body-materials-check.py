"""Exercise restored source ownership and real registered clothing behind a wave."""
import sys,json
from pathlib import Path
import numpy as np
from PIL import Image

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'src/artwork'))
from body_materials import build_source_body
from materialize import rest_arm

evidence=root/'evidence/single-image-live2d'
source=np.asarray(Image.open(evidence/'00/hachi-front.png').convert('RGBA'))
folder=evidence/'02/hachi-native-body-materials'
garment=np.asarray(Image.open(folder/'registered-flash-garment.png').convert('RGBA'))
receipt=json.loads((folder/'body-materials.json').read_text())
box=receipt['sourceArmBox'];x,y,w,h=box
mask=rest_arm(source,box)
head=(np.indices(source.shape[:2])[0]<143)&(source[:,:,3]>0)
blank=np.zeros_like(head)
out=build_source_body(source,[],head,blank,garment,box,mask)
parts=out['parts']
assert {p['semantic'] for p in parts}=={'upper-body','lower-body','arm:right','leg:left','leg:right','body:underlay:waist'}
base=Image.fromarray(np.where(head[:,:,None],source,0).astype(np.uint8))
for p in parts:
    if p['semantic']=='body:underlay:waist':
        assert not p['visible'] and p['variant']=={'type':'switch','parameter':'ParamWave','switch_id':1}
        assert p['y']>y+h*.45 # stop the original sleeve from reappearing.
        assert (p['rgba'][:,:,3]>0).sum()>600
        continue
    if p['semantic'].startswith('leg:'):
        assert p['y']>source.shape[0]*.54 # the skirt never moves with the leg.
    base.alpha_composite(Image.fromarray(p['rgba']),(p['x'],p['y']))
limb=source[y:y+h,x:x+w].copy()
limb[:,:,3][~out['restMask']]=0
base.alpha_composite(Image.fromarray(limb),(x,y))
assert np.array_equal(np.asarray(base),source), 'restoring both arms and legs must restore every source pixel'
assert build_source_body(source,[],head,blank,np.roll(garment,155,axis=0),box,mask) is None
assert build_source_body(source,[],head,blank,garment,box,None) is None
