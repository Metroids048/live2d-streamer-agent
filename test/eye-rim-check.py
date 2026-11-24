"""A blink must not drag light eye makeup with the upper lash."""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'src/artwork'))
from facial_materials import extract_face_details
from source_head import extend_observed_lids, source_owner

fixture = root / 'evidence/single-image-live2d'
image = np.asarray(Image.open(fixture / '00/hachi-front.png').convert('RGBA'))
regions = json.loads((fixture / '02/hachi-native-material-development/provenance.json').read_text())['regions']
details = extract_face_details(image, regions)
# The registered underlying complexion is synthetic here. This checks pigment
# ownership and neutral recomposition, separately from the real Flash job.
face = np.zeros_like(image)
face[64:140, 347:425] = [248, 216, 209, 255]
placed = {'face': {'rgba': face, 'rect': [347, 64, 425, 140]},
          'nose': {'rect': [381, 101, 393, 114]}, 'hair:front': {'rgba': np.zeros_like(image)}}

parts = extend_observed_lids(image, details, placed, ['half-blink', 'occlusion-completion'])
for side in ('left', 'right'):
    by_role = {part['semantic']: part for part in parts}
    lash = by_role['eye:lash:upper:' + side]
    rim = by_role['eye:rim:' + side]
    lash_mask = source_owner([lash], image.shape[:2])
    rim_mask = source_owner([rim], image.shape[:2])
    assert not np.any(lash_mask & rim_mask)
    assert rim_mask.sum() > 12 and lash_mask.sum() > 12
    assert np.mean(image[:, :, :3][lash_mask]) + 12 < np.mean(image[:, :, :3][rim_mask])
    for part, owned in [(lash, lash_mask), (rim, rim_mask)]:
        skin = placed['face']['backingRgb']
        x, y = part['x'], part['y']
        h, w = part['rgba'].shape[:2]
        output = Image.fromarray(skin[y:y+h, x:x+w]).convert('RGBA')
        output.alpha_composite(Image.fromarray(part['rgba']))
        mask = part['eraseMask']
        error = np.abs(np.asarray(output)[:, :, :3].astype(int) - image[y:y+h, x:x+w, :3])
        assert error[mask].max() <= 2, error[mask].max()
