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
    # A strict-color bounding box drops partially covered edge pixels. For a
    # small landmark that can lose several native points at fractional zoom.
    # Recover coverage using source-over compositing on the fixture's white
    # page, then measure horizontal and vertical extents independently.
    vector = tuple(255 - channel for channel in color)
    norm = sum(channel * channel for channel in vector)
    if norm == 0:
        raise ValueError("landmark color cannot be the white page background")
    solid = set(points)
    coverage = {point: 1 for point in solid}
    for y in range(max(math.ceil(top), y0 - 2), min(math.floor(bottom), y1 + 2)):
        for x in range(max(math.ceil(left), x0 - 2), min(math.floor(right), x1 + 2)):
            if (x, y) in solid:
                continue
            alpha = sum((255 - pixels[x, y][i]) * vector[i] for i in range(3)) / norm
            if alpha < 1 / 255 or alpha > 1 + 16 / 255:
                continue
            alpha = min(alpha, 1)
            expected = tuple(255 - alpha * channel for channel in vector)
            if max(abs(pixels[x, y][i] - expected[i]) for i in range(3)) <= 16:
                coverage[x, y] = alpha
    # Only pixels connected to the verified solid landmark count.
    # Nearby matching antialiasing or disconnected noise cannot enlarge it.
    pending = list(points)
    connected = set(points)
    while pending:
        x, y = pending.pop()
        for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if neighbor in coverage and neighbor not in connected:
                connected.add(neighbor)
                pending.append(neighbor)
    rows, columns = {}, {}
    for x, y in connected:
        rows.setdefault(y, {})[x] = coverage[x, y]
        columns.setdefault(x, {})[y] = coverage[x, y]

    def extent(line):
        first, last = min(line), max(line)
        if first == last:
            return first + (1 - line[first]) / 2, first + (1 + line[first]) / 2
        # Interior holes must not shrink an incorrect rectangular landmark.
        # Fractional corrections apply only to the two outside edge pixels.
        start = first + 1 - line[first]
        end = last + line[last]
        return start, end

    horizontal = [extent(line) for line in rows.values()]
    vertical = [extent(line) for line in columns.values()]
    left_edge, right_edge = min(start for start, _ in horizontal), max(end for _, end in horizontal)
    top_edge, bottom_edge = min(start for start, _ in vertical), max(end for _, end in vertical)
    width, height = right_edge - left_edge, bottom_edge - top_edge
    cx, cy = (left_edge + right_edge) / 2, (top_edge + bottom_edge) / 2
    return {"pixels": len(points), "pixelScale": sx,
            "x": (cx - width / 2) / sx + display["x"],
            "y": (cy - height / 2) / sy + display["y"],
            "width": width / sx, "height": height / sy,
            "cx": cx / sx + display["x"],
            "cy": cy / sy + display["y"]}


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
