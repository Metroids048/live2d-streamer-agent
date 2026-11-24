"""Register generated palm art against this candidate's measured sleeve cuff."""
import json
import sys
from pathlib import Path

import cv2 as cv
import numpy as np
from PIL import Image


def split_outward_sleeve(parts_dir, data, arm, cuff, offset):
    """Author upper sleeve, forearm, and a hidden joint backing from this sleeve."""
    rig = arm["rigging"]["continuousWave"]
    shoulder, elbow, wrist = (np.asarray(rig[k], float)-offset for k in ("shoulder", "elbow", "wrist"))
    axis = wrist-shoulder
    axis /= np.linalg.norm(axis)
    rows, cols = np.ogrid[:cuff.shape[0], :cuff.shape[1]]
    x, y = cols-elbow[0], rows-elbow[1]
    along = x*axis[0]+y*axis[1]
    across = -x*axis[1]+y*axis[0]
    # The source renderer uses alpha 250–253 even across solid cloth.
    # Erode the interior before allowing a duplicate pixel in the overlap.
    opaque = cuff[:,:,3] >= 245
    cross_section = across[(abs(along)<3) & opaque]
    if len(cross_section)<30:
        return False
    lo, hi = np.percentile(cross_section, [1,99])
    width = max(-lo, hi)
    if min(-lo, hi) < width*.63:
        return False
    arc = np.sqrt(np.maximum(0, 1-(across/(width*1.1))**2))
    interior = cv.erode(opaque.astype(np.uint8), np.ones((3,3),np.uint8)).astype(bool)
    upper = (along < 0) | (interior & (along < width*.57*arc))
    fore = (along >= 0) | (interior & (along > -width*.59*arc))
    overlap = upper & fore
    # Split coverage in the overlapping cloth so source-over recovers the
    # original alpha instead of darkening the neutral sleeve.
    shared_alpha = np.rint(255*(1-np.sqrt(1-cuff[:,:,3].astype(float)/255))).astype(np.uint8)
    for layer_id, mask in [(arm["id"], upper), ("wave-forearm", fore)]:
        rgba = cuff.copy()
        rgba[:,:,3] *= mask
        rgba[overlap,3] = shared_alpha[overlap]
        Image.fromarray(rgba).save(parts_dir/(layer_id+".png"))
    pigment = np.median(cuff[(abs(along)<width*.23)&(abs(across)<width*.45)&opaque,:3],axis=0)
    if not np.isfinite(pigment).all():
        raise ValueError("肘部补布缺少原袖内侧颜色")
    radius = width*1.01
    radial = np.hypot(along,across)
    backing = np.zeros_like(cuff)
    backing[:,:,:3] = np.clip(pigment[None,None,:]-np.clip(radial-radius*.63,0,radius*.37)[:,:,None]*.68,0,255)
    backing[:,:,3] = np.rint(np.clip((radius+1-radial)/2,0,1)*255).astype(np.uint8)
    Image.fromarray(backing).save(parts_dir/"wave-elbow-backing.png")
    def part(layer_id, name, role, **extra):
        p = json.loads(json.dumps(arm))
        p.update(id=layer_id, name=name, tags=["arm","wave",role], **extra)
        return p
    arm["tags"].append("split-upper-sleeve")
    data["parts"] = [p for p in data["parts"] if p["id"]!="wave-elbow-fold"]
    i = data["parts"].index(arm)
    data["parts"][i:i+1] = [
        part("wave-elbow-backing","Elbow fabric backing","split-elbow-backing",opacity=0,origin="generated"),
        arm, part("wave-forearm","Forearm and original cuff","split-forearm")]
    return True


def draw_local_palm(skin_color, outline_color, mirror):
    # A relaxed greeting seen from the palm side. Keep neighboring fingers
    # close, with the middle finger longest and a lower, partly tucked thumb.
    points = np.array([
        (106, 246), (105, 222), (94, 204), (87, 180), (78, 138),
        (76, 126), (82, 121), (90, 131), (102, 166), (103, 149),
        (95, 101), (95, 88), (103, 84), (112, 92), (122, 138),
        (126, 153), (129, 136), (127, 80), (128, 67), (137, 62),
        (145, 70), (147, 128), (148, 151), (154, 135), (159, 92),
        (163, 80), (171, 77), (178, 86), (175, 139), (172, 160),
        (173, 178), (181, 168), (191, 154), (202, 151), (207, 158),
        (203, 169), (188, 187), (177, 208), (160, 224), (159, 246),
    ], dtype=float)
    scale = 3
    contour = []
    for i, b in enumerate(points):
        a, c, d = points[(i-1) % len(points)], points[(i+1) % len(points)], points[(i+2) % len(points)]
        u = np.linspace(0, 1, 8, endpoint=False)[:, None]
        contour.extend(b + .38 * (c-a)*u + (3*(c-b)-.76*(c-a)-.38*(d-b))*u*u
                       + (2*(b-c)+.38*(c-a)+.38*(d-b))*u*u*u)
    size = 268 * scale
    matte = np.zeros((size, size), dtype=np.uint8)
    cv.fillPoly(matte, [np.rint(np.array(contour)*scale).astype(np.int32)], 255)
    y, x = np.indices(matte.shape, dtype=np.float32) / scale
    shadow = .36*np.exp(-((x-169)/38)**2-((y-183)/57)**2) + .16*np.exp(-((x-95)/35)**2)
    highlight = .22*np.exp(-((x-123)/31)**2-((y-157)/58)**2)
    paint = skin_color + shadow[:, :, None] * [-31,-55,-56] + highlight[:, :, None] * [12,25,31]
    edge = np.clip(cv.distanceTransform(matte, cv.DIST_L2, 3)/(scale*.95), 0, 1)[:, :, None]
    paint = paint * edge + outline_color * (1-edge)
    crease = tuple(np.clip(skin_color - [25,48,52], 0, 255).tolist())
    for line in [[(104,173),(122,170),(143,173)],[(151,180),(146,194),(136,207)],
                 [(105,186),(117,191),(123,197)],[(132,106),(141,106)],[(161,116),(169,116)],
                 [(102,117),(110,115)],[(83,143),(90,141)]]:
        cv.polylines(paint, [np.array(line)*scale], False, crease, scale)
    rgba = np.dstack((np.clip(paint, 0, 255), matte)).astype(np.uint8)
    tips = points[[6,12,19,26,34]].copy()
    if mirror:
        rgba = rgba[:, ::-1].copy()
        tips[:,0] = 268 - 1/scale - tips[:,0]
    return rgba, tips * scale


def register(parts_dir, data, generated):
    arm = next(p for p in data["parts"] if p["id"] == "wave-sleeve")
    rig = arm["rigging"]["continuousWave"]
    source = np.array(Image.open(parts_dir / "wave-sleeve.png").convert("RGBA"))
    offset = np.array([arm["rect"]["left"], arm["rect"]["top"]], dtype=float)
    wrist = np.asarray(rig["wrist"], dtype=float) - offset
    distal = np.mean(rig["fingertips"], axis=0) - offset - wrist
    length = np.linalg.norm(distal)
    distal /= length
    transverse = np.array([-distal[1], distal[0]])
    # Search only the measured wrist neighborhood and require a cuff edge that
    # crosses the arm. No character coordinates or prescribed sleeve slope.
    radius = max(16, round(length * .48))
    x0, y0 = np.maximum(0, np.floor(wrist - radius)).astype(int)
    x1, y1 = np.minimum(source.shape[1::-1], np.ceil(wrist + radius)).astype(int)
    tile = source[y0:y1, x0:x1]
    edges = cv.Canny(cv.cvtColor(tile, cv.COLOR_RGBA2GRAY), 55, 130)
    lines = cv.HoughLinesP(edges, 1, np.pi / 180, max(8, radius // 5),
                          minLineLength=radius * .45, maxLineGap=radius * .22)
    fits = []
    for line in ([] if lines is None else lines.reshape(-1, 4)):
        a, b = line.reshape(2, 2) + [x0, y0]
        edge = b - a
        width = np.linalg.norm(edge)
        unit = edge / width
        normal = np.array([-unit[1], unit[0]])
        if np.dot(normal, distal) < 0:
            normal *= -1
        distance = np.dot(a - wrist, normal)
        if abs(np.dot(unit, distal)) < .35 and abs(distance) < radius * .19:
            fits.append((width, distance, normal))
    if not fits:
        raise ValueError("未找到可核验的袖口接腕边界")
    _, edge, distal = max(fits, key=lambda fit: fit[0])
    edge += max(1, length * .014)
    transverse = np.array([-distal[1], distal[0]])
    padding = round(length * .75)
    source = np.pad(source, ((0, padding), (padding, padding), (0, 0)))
    offset -= [padding, 0]
    wrist = np.asarray(rig["wrist"]) - offset
    sy, sx = np.indices(source.shape[:2])
    along = (sx - wrist[0]) * distal[0] + (sy - wrist[1]) * distal[1]
    across = (sx - wrist[0]) * transverse[0] + (sy - wrist[1]) * transverse[1]
    hsv = cv.cvtColor(source[:, :, :3], cv.COLOR_RGB2HSV)
    skin = (source[:, :, 3] >= 240) & (hsv[:, :, 0] < 30) & (hsv[:, :, 1] > 36) & (hsv[:, :, 2] > 171)
    sample = across[skin & (np.abs(along - edge - length * .075) < max(2, length * .017))]
    if len(sample) < 8:
        raise ValueError("袖口肤色截面不足，不能自动接腕")
    width = float(np.quantile(sample, .97) - np.quantile(sample, .03))
    length = max(np.dot(np.asarray(tip) - offset - wrist, distal) for tip in rig["fingertips"])
    # Keep the original profile when the local alternate has a much shorter
    # projected reach. A crossfade would expose both silhouettes at the cuff.
    source_side = generated is None and length - edge > width * 2.2 * 1.5
    arm["rect"] = dict(left=int(offset[0]), top=int(offset[1]), width=source.shape[1], height=source.shape[0])
    cuff, rest = source.copy(), source.copy()
    cuff[:, :, 3] *= along < edge
    rest[:, :, 3] *= along >= edge
    resting = json.loads(json.dumps(arm))
    resting.update(id="wave-rest-hand", name="Original resting hand",
                   tags=["arm", "wave", "palm-rest-variant"])
    if source_side:
        resting["tags"].append("source-side-wave")
        data["parts"].insert(data["parts"].index(arm), resting)
        Image.fromarray(cuff).save(parts_dir / "wave-sleeve.png")
        Image.fromarray(rest).save(parts_dir / "wave-rest-hand.png")
        split = rig["direction"]==-1 and split_outward_sleeve(parts_dir, data, arm, cuff, offset)
        data["palmRegistration"] = dict(method="source_side_profile", cuffWidth=width, distalLength=length,
                                        seamOffset=float(edge), fingertips=rig["fingertips"],splitSleeve=split)
        return
    local_tips = None
    if generated is None:
        skin_color = np.median(source[skin, :3], axis=0)
        hand_rim = (source[:, :, 3] >= 240) & (along > edge) & (hsv[:, :, 2] < 170)
        ink = np.median(source[hand_rim, :3], axis=0) if np.count_nonzero(hand_rim) >= 8 else skin_color * [.67,.56,.53]
        hand, local_tips = draw_local_palm(skin_color, ink, rig["wrist"][0] > data["canvas"]["width"] / 2)
    else:
        hand = np.array(Image.open(generated).convert("RGBA"))
    count, labels, stats, _ = cv.connectedComponentsWithStats((hand[:, :, 3] >= 128).astype(np.uint8))
    if count < 2:
        raise ValueError("补绘掌面没有不透明轮廓")
    matte = labels == (1 + stats[1:, -1].argmax())
    ys, xs = np.nonzero(matte)
    base_y = np.quantile(ys[ys > ys.max() - max(4, hand.shape[0] * .02)], .8)
    base_cols = xs[ys == round(base_y)]
    base = np.array([np.median(base_cols), base_y])
    gen_length = base_y - ys.min()
    gen_width = np.quantile(base_cols, .96) - np.quantile(base_cols, .04)
    if min(gen_width, gen_length) < 12:
        raise ValueError("补绘掌面缺少下方接腕截面")
    contour = max(cv.findContours(matte.astype(np.uint8), cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE)[0], key=cv.contourArea)[:, 0].astype(float)
    radius = np.linalg.norm(contour - base, axis=1)
    window = max(4, round(gen_length * .042))
    a = np.roll(contour, window, axis=0) - contour
    b = np.roll(contour, -window, axis=0) - contour
    cosine = np.sum(a * b, axis=1) / np.maximum(1, np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))
    convex = a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0] > 0
    tips = []
    for i in np.argsort(cosine)[::-1]:
        if not convex[i] or radius[i] < radius.max() * .45 or cosine[i] < -.3 or contour[i, 1] > base_y - gen_length * .18:
            continue
        if any(np.linalg.norm(contour[i] - tip) < gen_length * .10 for tip in tips):
            continue
        tips.append(contour[i])
        if len(tips) == 5:
            break
    if local_tips is not None:
        tips = local_tips
    if len(tips) != 5:
        raise ValueError("补绘掌面未检测到五个独立指尖")
    # Match the original wrist width and distal reach, keeping the palm's spread
    # proportional to this character instead of the generator's canvas size.
    gy, gx = np.indices(matte.shape, dtype=np.float32)
    spread = np.clip((base_y - gy) / gen_length * 2.5, 0, 1)
    hand = cv.remap(hand, (base[0] + (gx - base[0]) / (1 - .25 * spread)).astype(np.float32), gy, cv.INTER_LINEAR)
    root = wrist + distal * (edge - max(3, width * .095))
    # The resting art supplies the cuff, but its longest extended fingertip
    # is not the projected length of the relaxed palm in the greeting pose.
    reach = min(length - edge, width * 2.2) if generated is None else length - edge
    matrix = np.column_stack((transverse * width / gen_width, -distal * (reach + width * .095) / gen_length))
    target = cv.warpAffine(hand.astype(np.float32), np.column_stack((matrix, root - matrix @ base)), source.shape[1::-1], flags=cv.INTER_LINEAR)
    take = skin & (along > edge + width * .13) & (along < edge + width * .46) & (np.abs(across) < width * .26)
    take_gen = matte & (gy > base_y - gen_length * .12) & (np.abs(gx - base[0]) < gen_width * .25)
    if min(np.count_nonzero(take), np.count_nonzero(take_gen)) < 8:
        raise ValueError("接腕肤色样本不足")
    target[:, :, :3] = np.clip(target[:, :, :3] + np.median(source[take, :3], axis=0) - np.median(hand[take_gen, :3], axis=0), 0, 255)
    # Keep one opaque sleeve through the gesture. Switching two complete
    # sleeves makes the cuff translucent at the handoff, even if they align.
    # Put the palm and resting hand behind the same cuff.
    Image.fromarray(cuff).save(parts_dir / "wave-sleeve.png")
    Image.fromarray(rest).save(parts_dir / "wave-rest-hand.png")
    layer = json.loads(json.dumps(arm))
    layer.update(id="wave-palm", name="Open palm", opacity=0, origin="generated",
                 tags=["arm", "wave", "palm-variant"])
    mapped = []
    for tip in tips:
        tip = tip.copy()
        tip[0] = base[0] + (tip[0] - base[0]) * (1 - .25 * np.clip((base_y - tip[1]) / gen_length * 2.5, 0, 1))
        mapped.append((matrix @ (tip - base) + root + offset).tolist())
    layer["rigging"]["continuousWave"]["fingertips"] = mapped
    Image.fromarray(target.astype(np.uint8)).save(parts_dir / "wave-palm.png")
    index = data["parts"].index(arm)
    data["parts"][index:index] = [resting, layer]
    method = "source_cuff_and_relaxed_local_palm" if generated is None else "source_cuff_contour_and_generated_five_tips"
    data["palmRegistration"] = dict(method=method, cuffWidth=width, distalLength=length,
                                    seamOffset=float(edge), fingertips=mapped)


if __name__ == "__main__":
    parts_dir, data_path = map(Path, sys.argv[1:3])
    generated = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    data = json.loads(data_path.read_text())
    register(parts_dir, data, generated)
    print(json.dumps(data))
