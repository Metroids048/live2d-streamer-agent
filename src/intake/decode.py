"""Decode a controlled single PNG/JPEG; normalize orientation, ICC and metadata.

Pillow is already installed locally. This helper never downloads or installs it.
Paths arrive as execFile arguments, never shell text. Output stays in intake/.
"""
import hashlib
import io
import json
import os
import struct
import sys
import warnings

try:
    import PIL
    from PIL import Image, ImageCms, ImageFile, ImageOps
except ImportError:
    print(json.dumps({"error": "DECODER_UNAVAILABLE"}))
    sys.exit(0)

MAX_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_SIDE = 8192
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
ImageFile.LOAD_TRUNCATED_IMAGES = False
warnings.simplefilter("error", Image.DecompressionBombWarning)


def decode(source, target):
    if os.path.getsize(source) > MAX_BYTES:
        return {"error": "IMAGE_TOO_LARGE"}
    with open(source, "rb") as raw:
        header = raw.read(26)
    if header[:8] == b"\x89PNG\r\n\x1a\n" and len(header) > 24 and header[24] == 16:
        return {"error": "IMAGE_BIT_DEPTH_UNSUPPORTED"}
    with Image.open(source) as probe:
        fmt = probe.format
        if fmt not in ("PNG", "JPEG"):
            return {"error": "IMAGE_FORMAT_UNSUPPORTED"}
        width, height = probe.size
        if max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
            return {"error": "IMAGE_DIMENSIONS_EXCEEDED"}
        if getattr(probe, "n_frames", 1) != 1:
            return {"error": "ANIMATED_IMAGE_UNSUPPORTED"}
        probe.verify()
    with Image.open(source) as image:
        image.load()  # verify() alone does not decode JPEG/PNG raster data.
        orientation = image.getexif().get(274, 1)
        if orientation not in range(1, 9):
            return {"error": "IMAGE_ORIENTATION_INVALID"}
        original_mode = image.mode
        alpha = "A" in image.getbands() or "transparency" in image.info
        icc = image.info.get("icc_profile")
        normalized = ImageOps.exif_transpose(image)
        conversions = []
        if orientation != 1:
            conversions.append("exif_orientation_to_1")
        if image.mode.startswith("I") or image.mode == "F":
            return {"error": "IMAGE_BIT_DEPTH_UNSUPPORTED"}
        if icc:
            profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            # Palette/grayscale alpha is expanded before the ICC conversion.
            working = normalized
            alpha_band = None
            if alpha:
                expanded = normalized.convert("RGBA")
                alpha_band = expanded.getchannel("A")
                working = normalized.getchannel("L") if normalized.mode == "LA" else expanded.convert("RGB")
            elif normalized.mode in ("P", "1"):
                working = normalized.convert("RGB")
            color = ImageCms.profileToProfile(
                working, profile, ImageCms.createProfile("sRGB"),
                outputMode="RGB",
            )
            if alpha_band is not None:
                color.putalpha(alpha_band)
            conversions.append("embedded_icc_to_srgb")
        else:
            if image.mode == "CMYK":
                return {"error": "CMYK_PROFILE_REQUIRED"}
            color = normalized.convert("RGBA" if alpha else "RGB")
            conversions.append("untagged_color_assumed_srgb")
        # Construct a fresh image so EXIF/GPS/text/embedded thumbnails are omitted.
        clean = Image.frombytes(color.mode, color.size, color.tobytes())
        pixels = clean.tobytes()
        pixel_hash = hashlib.sha256(
            clean.mode.encode("ascii") + struct.pack(">II", *clean.size) + pixels
        ).hexdigest()
        with open(target, "xb") as out:
            os.chmod(target, 0o600)
            clean.save(out, format="PNG", compress_level=6)
        with Image.open(target) as check:
            check.load()
            if check.size != clean.size or check.mode != clean.mode:
                return {"error": "NORMALIZATION_FAILED"}
        return {
            "format": fmt, "mimeType": "image/png" if fmt == "PNG" else "image/jpeg",
            "originalWidth": width, "originalHeight": height,
            "originalOrientation": orientation, "originalMode": original_mode,
            "width": clean.width, "height": clean.height, "orientation": 1,
            "hasAlpha": alpha, "pixelSha256": pixel_hash,
            "conversions": conversions + ["metadata_removed", "lossless_png"],
            "decoder": {"name": "Pillow", "version": PIL.__version__},
        }


try:
    print(json.dumps(decode(sys.argv[1], sys.argv[2]), ensure_ascii=False))
except (Image.DecompressionBombError, Image.DecompressionBombWarning):
    print(json.dumps({"error": "IMAGE_DIMENSIONS_EXCEEDED"}))
except FileExistsError:
    print(json.dumps({"error": "NORMALIZATION_TARGET_EXISTS"}))
except Exception:
    # Decoder errors can contain private paths/metadata; never echo them.
    print(json.dumps({"error": "IMAGE_DECODE_FAILED"}))
