"""Extract visible semantic masks. The model does not reconstruct hidden pixels."""
import fcntl
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image


def main():
    checkout, checkpoint, source, output, lock_file = map(Path, sys.argv[1:])
    sys.path.insert(0, str(checkout))
    from compiler.body_parser import parse_body_regions

    image = Image.open(source).convert("RGBA")
    base = Image.new("RGBA", image.size, (240, 240, 240, 255))
    base.alpha_composite(image)
    foreground = np.asarray(image.getchannel("A")) > 0
    with lock_file.open("a+") as lock:
        deadline = time.monotonic() + 120
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Shared local vision model slot remained busy for 120s")
                time.sleep(0.5)
        masks = parse_body_regions(base, ckpt=str(checkpoint), device="auto")
    parts = []
    for name, mask in masks.items():
        pixels = (np.asarray(mask) > 0) & foreground
        area = int(np.count_nonzero(pixels))
        if area < 32:
            continue
        mask = Image.fromarray(pixels.astype(np.uint8) * 255)
        cutout = image.copy()
        cutout.putalpha(Image.fromarray(np.where(pixels, np.asarray(image.getchannel("A")), 0)))
        cutout.save(output / f"{name}.png")
        parts.append({"id": name, "visiblePixels": area, "bounds": mask.getbbox()})
    print(json.dumps({"canvas": list(image.size), "parts": parts}))


if __name__ == "__main__":
    main()
