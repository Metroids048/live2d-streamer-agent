"""Build editable PSD2Live layers from a reviewed, source-bound mask map."""
import argparse
import hashlib
from itertools import groupby
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("map", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    recipe = json.loads(args.map.read_text())
    source_sha = hashlib.sha256(args.source.read_bytes()).hexdigest()
    if source_sha != recipe["sourceSha256"]:
        raise ValueError("Mask map does not belong to this source")

    source = Image.open(args.source).convert("RGBA")
    crop = tuple(recipe["crop"])
    left, top, right, bottom = crop
    if not (0 <= left < right <= source.width and 0 <= top < bottom <= source.height):
        raise ValueError("Crop lies outside source")
    source = source.crop(crop)
    size = source.size

    def points(coordinates):
        return [(x - crop[0], y - crop[1]) for x, y in coordinates]

    def mask(outline):
        result = Image.new("L", size)
        ImageDraw.Draw(result).polygon(points(outline), fill=255)
        return result

    if "outerMatte" in recipe:
        source.putalpha(ImageChops.multiply(source.getchannel("A"), mask(recipe["outerMatte"])))

    original_alpha = source.getchannel("A")
    remaining = original_alpha.copy()
    parts = {}
    definitions = recipe["layers"]
    groups = [group for group, _ in groupby(definitions, key=lambda layer: layer["group"])]
    if len(set(groups)) != len(groups):
        raise ValueError("PSD groups must occupy contiguous runs in draw order")
    for layer in reversed(definitions):
        if layer["id"] in parts:
            raise ValueError("Duplicate layer ID")
        outline = layer.get("outline")
        visible = layer.get("visible", True)
        artwork = Image.new("RGBA", size)
        occluded = ImageChops.subtract(original_alpha, remaining).point(
            lambda alpha: 255 if alpha == 255 else 0
        )
        for patch in layer.get("underpaint", []):
            region = mask(patch["outline"])
            if visible:
                region = ImageChops.multiply(region, occluded)
            artwork.paste(tuple(patch["rgba"]), (0, 0), region)
        source_pixels = Image.new("L", size)
        if visible:
            region = mask(outline) if outline else Image.new("L", size, 255)
            source_pixels = ImageChops.multiply(remaining, region)
            remaining = ImageChops.subtract(remaining, source_pixels)
            piece = source.copy()
            piece.putalpha(source_pixels)
            artwork = Image.alpha_composite(artwork, piece)
        if layer.get("strokes"):
            scale = 4
            strokes = Image.new("RGBA", (size[0] * scale, size[1] * scale))
            for stroke in layer["strokes"]:
                coords = [(x * scale, y * scale) for x, y in points(stroke["points"])]
                ImageDraw.Draw(strokes).line(coords, fill=tuple(stroke["rgba"]),
                                             width=stroke["width"] * scale, joint="curve")
            artwork = Image.alpha_composite(artwork, strokes.resize(size, Image.Resampling.LANCZOS))
        parts[layer["id"]] = (artwork, source_pixels.histogram()[255])

    if remaining.getbbox():
        raise ValueError("Mask map did not assign every source pixel")
    args.output.mkdir()
    (args.output / "layers").mkdir()
    composite = Image.new("RGBA", size)
    layers = []
    provenance = []
    for layer in definitions:
        identifier = layer["id"]
        if not identifier.isascii() or not identifier.replace("-", "").isalnum():
            raise ValueError("Invalid layer ID")
        artwork, pixel_count = parts[identifier]
        bounds = artwork.getbbox()
        if not bounds:
            raise ValueError(f"Empty layer: {identifier}")
        x, y, right, bottom = bounds
        w, h = right - x, bottom - y
        visible = layer.get("visible", True)
        relative = f"layers/{identifier}.png"
        artwork.crop(bounds).save(args.output / relative)
        if visible:
            composite = Image.alpha_composite(composite, artwork)
        layers.append({
            "id": identifier, "name": layer["name"], "group": layer["group"],
            "image": {"path": relative, "width": w, "height": h},
            "rect": {"left": x, "top": y, "width": w, "height": h},
            "visible": visible, "opacity": 1,
        })
        provenance.append({"id": identifier, "opaqueSourcePixels": pixel_count,
                           "hasUnderpaint": bool(layer.get("underpaint")),
                           "hasDrawnStrokes": bool(layer.get("strokes"))})

    composite.save(args.output / "neutral.png")
    visible_mask = original_alpha.point(lambda alpha: 255 if alpha else 0)
    red, green, blue, alpha = ImageChops.difference(composite, source).split()
    rgb_difference = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    neutral_matches = not alpha.getbbox() and not ImageChops.multiply(rgb_difference, visible_mask).getbbox()
    write_json(args.output / "layout.json", {
        "format": "psd2live-layout", "version": 1, "name": recipe["name"],
        "canvas": dict(zip(("width", "height"), size)),
        "groups": [{"path": group, "visible": True, "opacity": 1} for group in groups],
        "layers": layers,
    })
    write_json(args.output / "source-report.json", {
        "sourceSha256": source_sha,
        "maskMapSha256": hashlib.sha256(args.map.read_bytes()).hexdigest(),
        "scope": "editable artwork only; reviewed masks are character-specific",
        "sourceCrop": crop, "neutralMatchesSourceCrop": neutral_matches, "parts": provenance,
    })


if __name__ == "__main__":
    main()
