"""Local decomposition of transparent, hard-edged, color-blocked portraits.

The supported grammar requires a warm face, two light eyes with warm pupils,
dark lashes, a red mouth, cool hair and a separately colored teal sleeve.
Only the flattened upload is read. Regions that cannot be separated are rejected.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np

image = Image.open(sys.argv[1]).convert('RGBA')
pixels = np.asarray(image)
h, w = pixels.shape[:2]
r, g, b, a = (pixels[:, :, i].astype(int) for i in range(4))
y, x = np.indices((h, w))
opaque = a > 0


def require(condition, label):
    if not condition:
        raise ValueError(label)


def box(mask):
    ys, xs = np.where(mask)
    require(xs.size, '未找到独立颜色区域')
    return int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)


def fill(mask, color):
    result = np.zeros_like(pixels)
    result[mask] = color
    return result


def pigment(mask):
    colors, counts = np.unique(pixels[mask], axis=0, return_counts=True)
    return colors[np.argmax(counts)]


require(w * h <= 4_000_000 and a.min() == 0 and np.all((a == 0) | (a == 255)),
        '需要透明背景、实色轮廓的单人插画')
skin = opaque & (r > 170) & (g > 105) & (r > g + 19) & (g > b + 20) & (b > 55)
l, t, rr, bb = box(skin)
fw = rr - l
center = (l + rr) / 2
# The teal sleeve is disjoint in chroma from skin, costume and blue hair.
arm = opaque & (g > r + 24) & (b > r + 17) & (g >= b - 12) & (y > t + fw * .65)
al, at, ar, ab = box(arm)
require(ab - at > fw * .47 and ar - al < fw * .62 and (al >= center or ar <= center),
        '未检测到单侧连续肩袖、肘和腕')
split = int(at - fw * .10)
head = y < split
warm = (r > g + 20) & (g > b + 22) & (b < 45)
cream = (r > 230) & (g > 225) & (b > 185) & (r >= g) & (g > b)
lash = (r < 70) & (g < 43) & (b > r) & (b - g < 47)
brow = (r > 95) & (r < 155) & (g >= 40) & (g <= 95) & (b > g) & (r > b + 20)
lip = (r > 95) & (r > g + 60) & (g < 120) & (r > b + 45)
parts = []
claimed = np.zeros((h, w), dtype=bool)


def take(mask):
    mask = mask & opaque & ~claimed
    claimed[mask] = True
    return mask


def put(name, tags, data, *, hidden=False, origin='segmented', rigging=None):
    rect = box(data[:, :, 3] > 0)
    parts.append((name, tags, data, rect, hidden, origin, rigging))


def source(mask):
    return fill(mask, pixels[mask])


def drawn(draw):
    layer = Image.new('RGBA', image.size)
    draw(ImageDraw.Draw(layer))
    return np.array(layer)


eye_parts = []
regions = []
eye_pixels = np.zeros_like(claimed)
for side, half in [('right', x < center), ('left', x >= center)]:
    limit = head & half & (x > l + fw * .04) & (x < rr - fw * .04)
    visible_white = opaque & cream & limit
    ex, ey, er, eb = box(visible_white)
    ew, eh = er - ex, eb - ey
    require(fw * .12 <= ew <= fw * .32 and 5 < eh < ew * .9, '眼白区域不符合双眼色块结构')
    bounds = limit & (x >= ex - ew * .2) & (x < er + ew * .2) & (y >= ey - eh * .6) & (y < eb + eh * .3)
    iris = take(bounds & (warm | ((r > 246) & (g > 224) & (b > 130) & (b < 184))))
    lashes = take(bounds & lash)
    white = take(visible_white)
    brows = take(limit & brow & (y < ey + 2) & (y > ey - ew * .55))
    require(iris.sum() > 50 and lashes.sum() > 40 and brows.sum() > 20, '虹膜、上睫线或眉毛无法独立分离')
    eye_pixels |= iris | lashes | white | brows
    # Whiteness below the iris makes a continuous Live2D clipping source.
    matte = source(white)
    matte[iris] = pigment(white)
    matte[lashes & (y >= ey) & (x >= ex) & (x < er)] = pigment(white)
    closed = drawn(lambda d: d.line([(xx, round(ey + eh * (.68 + .25 * (1 - (2 * (xx-ex)/ew-1)**2))))
                                     for xx in range(ex, er)], fill=tuple(pigment(lashes)),
                                    width=max(2, round(ew * .061))))
    eye_parts.append((side, matte, source(iris), source(lashes), source(brows), closed))
    regions.append({'semantic':'eye_l' if side == 'left' else 'eye_r','box':[ex/w,ey/h,er/w,eb/h]})

mouth_limit = head & (x > l + fw * .30) & (x < rr - fw * .30)
mouth = take(mouth_limit & (lip | ((r > 195) & (g < 115) & (r > b + 75))) & (y > max(box(i[1][:,:,3] > 0)[3] for i in eye_parts)))
ml, mt, mr, mb = box(mouth)
require(mr-ml > fw * .10 and mr-ml < fw * .35 and mb-mt < (mr-ml)*.65,'口型区无法独立分离')
mid = (mt + mb) / 2
mouth_top = mouth & (y < mid) & (r > 130)
mouth_bottom = mouth & (y >= mid) & (r > 130)
cavity = source(mouth)
cavity[mouth_top | mouth_bottom] = pigment(mouth & ~(mouth_top | mouth_bottom))
closed_mouth = drawn(lambda d: d.line([(xx, round(mid + 2 * (1 - (2*(xx-ml)/(mr-ml)-1)**2)))
                                      for xx in range(ml + 2, mr - 2)], fill=tuple(pigment(mouth_top)),
                                      width=max(2, round((mr-ml)*.064))))

arm = take(arm)
# Extend near-contiguous darker marks inside the sleeve's row silhouette.
for yy in range(at, ab):
    cols = np.where(arm[yy])[0]
    if len(cols):
        arm[yy,cols[0]:cols[-1]+1] |= opaque[yy,cols[0]:cols[-1]+1]
claimed |= arm
def anchor(fraction):
    yy = min(ab-1, at+round((ab-at)*fraction))
    cols = np.where(arm[yy])[0]
    require(len(cols)>4, '肩、肘或腕的横截面不足')
    return [round(float(np.median(cols)), 1), yy]

shoulder, elbow, wrist = (anchor(f) for f in (.08,.46,.80))
outward = -1 if shoulder[0] > center else 1
# Limit curvature by measured width and span, so broad sleeves bend less.
span = float(np.linalg.norm(np.array(wrist)-shoulder))
degrees = [min(31,round(span*.23)), min(117,round(span*.84)), min(14,round(span*.10))]
regions.append({'semantic':'gesture:wave:rest','box':[al/w,at/h,ar/w,ab/h]})
neck = take(opaque & (r > 150) & (r > g + 25) & (g > b + 20) &
            (x > center-fw*.23) & (x < center+fw*.23) & (y >= split-fw*.04) & (y < at+fw*.13))
face = take(opaque & head & (r > 147) & (r > g + 16) & (g > b + 13))
front = take(opaque & head & (y < max(box(i[1][:,:,3] > 0)[1] for i in eye_parts)+fw*.12) &
             (b > r + 20) & ((g >= r-7) | ((r > 188) & (g > 188))))
back = take(opaque & (b > r + 35) & (g < r + 10) & (r < 65) & (y < at+fw*.25))
torso = take(opaque)
face_data = source(face)
face_color = pigment(face)
face_data[eye_pixels | mouth] = face_color
# Hidden forehead, constrained to the front-hair silhouette and a head ellipse.
fl, ft, fr, fb = box(face)
ellipse = ((x-(fl+fr)/2)/((fr-fl)*.45))**2 + ((y-(ft+fb)/2+fw*.17)/(fw*.41))**2 < 1
face_data[front & ellipse] = face_color
back_data = source(back)
back_data[front & ~ellipse] = pigment(back)
neck_data = source(neck)
nl, nt, nr, nb = box(neck)
neck_data[face & (x > nl+2) & (x < nr-2) & (y >= nt-fw*.11)] = pigment(neck)
torso_data = source(torso)
# Reconstruct the torso only where the same row's opposite edge supports it.
for yy in range(at, ab):
    xs = np.where(torso[yy])[0]
    if len(xs):
        mirror = int(2*center - (xs[0] if outward == -1 else xs[-1]))
        underneath = arm[yy] & ((x[yy] < mirror) if outward == -1 else (x[yy] > mirror))
        if underneath.any():
            nearby = xs[np.argmin(abs(xs-mirror))]
            torso_data[yy, underneath] = pixels[yy, nearby]

put('hair-back',['hair','back'],back_data,origin='inpainted')
put('torso',['body','clothes'],torso_data,origin='inpainted')
put('sleeve',['arm','sleeve','gesture','wave','continuous'],source(arm),rigging={'continuousWave':{
    'version':1,'shoulder':shoulder,'elbow':elbow,'wrist':wrist,'direction':outward,'degrees':degrees}})
put('neck',['neck'],neck_data,origin='inpainted')
put('face',['face','skin'],face_data,origin='inpainted')
put('hair-front',['hair','front'],source(front))
for side, white, iris, lashes, brows, closed in eye_parts:
    for suffix, tags, data, hidden, origin in [
        ('white',['eye','white'],white,False,'inpainted'),('iris',['eye','iris'],iris,False,'segmented'),
        ('upper',['eye','lash','upper'],lashes,False,'segmented'),('brow',['brow'],brows,False,'segmented'),
        ('closed',['eye','closed'],closed,True,'generated'),
    ]:
        put(side+'-'+suffix,tags+[side],data,hidden=hidden,origin=origin)
put('mouth-open',['mouth','open'],cavity,origin='inpainted')
put('mouth-upper',['mouth','line','upper'],source(mouth_top))
put('mouth-lower',['mouth','line','lower'],source(mouth_bottom))
put('mouth-closed',['mouth','closed'],closed_mouth,hidden=True,origin='generated')
composite = np.zeros_like(pixels)
for _, _, data, _, hidden, _, _ in parts:
    if not hidden:
        mask = data[:,:,3]>0
        composite[mask] = data[mask]
require(np.array_equal(composite[opaque],pixels[opaque]) and np.array_equal(composite[:,:,3],a),
        '角色原画中立重组出现色差或漏像素')
if len(sys.argv) > 2:
    out = Path(sys.argv[2])
    output = []
    for name,tags,data,rect,hidden,origin,rigging in parts:
        left,top,right,bottom = rect
        Image.fromarray(data[top:bottom,left:right]).save(out/(name+'.png'))
        entry = {'id':name,'name':name,'rect':dict(left=left,top=top,width=right-left,height=bottom-top),
                 'tags':tags,'visible':not hidden,'origin':origin}
        if hidden:
            entry['variant'] = {'type':'toggle','parameter':'Param'+name.replace('-','').title()}
        if rigging:
            entry['rigging'] = rigging
        output.append(entry)
else:
    output = []
print(json.dumps({'canvas':{'width':w,'height':h},'parts':output,'regions':regions,
                  'neutralSourceExact':True,'anchors':{'shoulder':shoulder,'elbow':elbow,'wrist':wrist,'degrees':degrees}}))
