"""Read actual native screenshots; never alter or synthesize acceptance proof."""
import io
import json
import math
import sys
from PIL import Image, ImageCms


def measure(image, display, viewport, color):
    numbers = [display[k] for k in ("x", "y", "width", "height", "pixelWidth", "pixelHeight")]
    numbers += [viewport[k] for k in ("x", "y", "width", "height")]
    if not all(math.isfinite(n) for n in numbers):
        raise ValueError("non-finite native display/viewport geometry")
    if min(display["width"], display["height"], viewport["width"], viewport["height"]) <= 0:
        raise ValueError("empty native display/viewport")
    if image.size != (display["pixelWidth"], display["pixelHeight"]):
        raise ValueError("screenshot is not the measured full native display")
    sx = image.width / display["width"]
    sy = image.height / display["height"]
    if abs(sx - sy) > 0.001:
        raise ValueError("anisotropic native screenshot scale")
    left = (viewport["x"] - display["x"]) * sx
    top = (viewport["y"] - display["y"]) * sy
    right = left + viewport["width"] * sx
    bottom = top + viewport["height"] * sy
    if left < 0 or top < 0 or right > image.width or bottom > image.height:
        raise ValueError("native PDF viewport extends outside the captured display")
    # Screenshots can carry a display ICC profile; compare in fixture sRGB.
    if image.info.get("icc_profile"):
        image = ImageCms.profileToProfile(
            image.convert("RGB"), ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"])),
            ImageCms.createProfile("sRGB"), outputMode="RGB")
    else:
        image = image.convert("RGB")
    pixels = image.load()
    points = [(x, y) for y in range(math.ceil(top), math.floor(bottom))
              for x in range(math.ceil(left), math.floor(right))
              if max(abs(pixels[x, y][i] - color[i]) for i in range(3)) <= 16]
    if len(points) < 16:
        raise ValueError("PDF center landmark has fewer than 16 rendered pixels")
    x0, x1 = min(p[0] for p in points), max(p[0] for p in points) + 1
    y0, y1 = min(p[1] for p in points), max(p[1] for p in points) + 1
    if len(points) / ((x1 - x0) * (y1 - y0)) < 0.85:
        raise ValueError("matching pixels do not form the fixture's solid landmark")
    return {"pixels": len(points), "pixelScale": sx,
            "x": x0 / sx + display["x"], "y": y0 / sy + display["y"],
            "width": (x1 - x0) / sx, "height": (y1 - y0) / sy,
            "cx": (x0 + x1) / (2 * sx) + display["x"],
            "cy": (y0 + y1) / (2 * sy) + display["y"]}


if __name__ == "__main__":
    with Image.open(sys.argv[1]) as image:
        request = json.loads(sys.argv[2])
        try:
            result = measure(image, request["display"], request["viewport"], request["color"])
        except ValueError as error:
            if not request.get("allowAbsent") or str(error) != "PDF center landmark has fewer than 16 rendered pixels":
                raise
            result = None
        print(json.dumps(result))
