"""Refine a semantic eye mask into source-space eye details."""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from facial_materials import extract_face_details
from anime_eye_regions import eye_regions


def main():
    source, eyes, output = map(Path,sys.argv[1:])
    image = np.asarray(Image.open(source).convert('RGBA'))
    mask = np.asarray(Image.open(eyes).convert('RGBA'))[:,:,3] > 127
    if mask.shape != image.shape[:2]:
        raise ValueError('eye mask canvas differs from the source')
    regions = eye_regions(mask)
    parts = []
    for part in extract_face_details(image,regions):
        rgba = part['rgba']
        name = part['semantic'].replace(':','-')
        Image.fromarray(rgba).save(output/(name+'.png'))
        parts.append(dict(id=name, semantic=part['semantic'], origin=part['origin'],
                          bounds=[part['x'],part['y'],part['x']+rgba.shape[1],part['y']+rgba.shape[0]]))
    print(json.dumps(dict(regions=regions,parts=parts)))


if __name__ == '__main__':
    main()
