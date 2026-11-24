"""Locate two compact eye components in a visible mask."""
import cv2
import numpy as np


def eye_regions(mask):
    height, width = mask.shape
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
    # Brow pixels can be labelled as eyes. Select the two compact components
    # only when they have comparable areas, heights and vertical positions.
    compact = [row for row in stats[1:] if row[4] >= 25 and .5 <= row[2]/row[3] <= 2.6]
    candidates = sorted(compact, key=lambda row: -row[4])
    if len(candidates) < 2 or (len(candidates) > 2 and candidates[2][4] >= .45*candidates[1][4]):
        return []
    left, right = sorted(candidates[:2], key=lambda row: row[0])
    lx, ly, lw, lh, la = left
    rx, ry, rw, rh, ra = right
    if lx+lw >= rx or min(la,ra) < .5*max(la,ra) or abs(ly+lh*.5-ry-rh*.5) > .35*max(lh,rh):
        return []
    regions = []
    for side, (x,y,w,h,_) in zip(('r','l'), (left,right)):
        px, py = max(2,round(w*.09)), max(2,round(h*.09))
        bounds = [max(0,x-px)/width, max(0,y-py)/height,
                  min(width,x+w+px)/width, min(height,y+h+py)/height]
        regions.append(dict(semantic='eye_'+side, box=bounds))
    return regions
