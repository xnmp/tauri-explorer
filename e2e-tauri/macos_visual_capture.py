"""Pillow image helpers for the hosted-Mac visual capture (#1750).

Subcommands (all print one JSON object on stdout):
  wallpaper OUT WIDTH HEIGHT   vivid, high-contrast desktop image
  stats PNG                    size and luminance spread; flags blank images
  crop IN OUT X Y W H          crop a pixel rectangle
  sheets FRAMES_DIR OUT_DIR    overview and per-burst contact sheets
  inspect SRC OUT_DIR PREFIX CROPS_JSON
                               4x nearest-neighbour detail crops plus one labelled sheet

Evidence tooling only: nothing here asserts product behaviour.
"""

from __future__ import annotations

import colorsys
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

OVERVIEW_FRAMES = 20
BURST_FRAMES = 24
MAX_BURSTS = 16
# A frame "moves" when this share of its pixels changed by more than
# PIXEL_DELTA grey levels. A sliding tab touches a small area of the strip, so
# a mean over the whole frame would miss it.
PIXEL_DELTA = 12
MOTION_THRESHOLD = 0.0005
# Moving frames closer than this (in frames and seconds) belong to one burst.
QUIET_GAP = 6
QUIET_SECONDS = 0.35


def emit(value: object) -> None:
    print(json.dumps(value, sort_keys=True))


def wallpaper(out: str, width: int, height: int) -> dict:
    """Rainbow diagonal gradient with hard black/white bars and discs.

    Sharp edges make the strength of the native blur visible; saturated hues
    make tint and opacity differences visible.
    """
    # Paint the gradient small and upscale it: a per-pixel loop at Retina
    # resolution takes minutes in pure Python.
    small_w, small_h = 192, 108
    gradient = Image.new("RGB", (small_w, small_h))
    pixels = gradient.load()
    for y in range(small_h):
        for x in range(small_w):
            hue = ((x / small_w) * 0.75 + (y / small_h) * 0.25) % 1.0
            r, g, b = colorsys.hsv_to_rgb(hue, 0.95, 1.0)
            pixels[x, y] = (int(r * 255), int(g * 255), int(b * 255))
    image = gradient.resize((width, height), Image.Resampling.BILINEAR)
    draw = ImageDraw.Draw(image)
    bar = max(8, width // 64)
    for index, x in enumerate(range(0, width, bar * 4)):
        colour = (0, 0, 0) if index % 2 == 0 else (255, 255, 255)
        draw.rectangle([x, 0, x + bar, height], fill=colour)
    for row in range(1, 6):
        y = row * height // 6
        draw.rectangle([0, y, width, y + bar // 2], fill=(0, 0, 0) if row % 2 else (255, 255, 255))
    radius = min(width, height) // 7
    for index, (cx, cy) in enumerate([(0.2, 0.3), (0.5, 0.65), (0.8, 0.25), (0.65, 0.85), (0.35, 0.8)]):
        r, g, b = colorsys.hsv_to_rgb((index * 0.37 + 0.5) % 1.0, 1.0, 1.0)
        box = [cx * width - radius, cy * height - radius, cx * width + radius, cy * height + radius]
        draw.ellipse(box, fill=(int(r * 255), int(g * 255), int(b * 255)), outline=(0, 0, 0), width=bar // 2)
    image.save(out)
    return {"path": out, "width": width, "height": height}


def stats(path: str) -> dict:
    image = Image.open(path).convert("RGB")
    grey = image.convert("L")
    stat = ImageStat.Stat(grey)
    extrema = grey.getextrema()
    stddev = stat.stddev[0]
    return {
        "path": path,
        "width": image.width,
        "height": image.height,
        "mean": round(stat.mean[0], 2),
        "stddev": round(stddev, 2),
        "min": extrema[0],
        "max": extrema[1],
        # A uniform image (all black, all white, one colour) has no detail.
        "blank": stddev < 2.0,
    }


def crop(source: str, out: str, x: int, y: int, w: int, h: int) -> dict:
    image = Image.open(source)
    box = (max(0, x), max(0, y), min(image.width, x + w), min(image.height, y + h))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise SystemExit(f"crop box {box} is outside {image.width}x{image.height}")
    image.crop(box).save(out)
    return {"path": out, "box": list(box)}


def read_times(frames_dir: Path, count: int) -> list[float | None]:
    times_file = frames_dir / "times.txt"
    times: list[float | None] = []
    if times_file.exists():
        for line in times_file.read_text().splitlines():
            try:
                times.append(float(line.strip().split(",")[0]))
            except ValueError:
                continue
    if len(times) != count:
        return [None] * count
    return times


def motion(frames: list[Path]) -> list[float]:
    """Per-frame change against the previous frame (0 for the first)."""
    scores = [0.0]
    previous = None
    for frame in frames:
        small = Image.open(frame).convert("L")
        small = small.resize((max(1, small.width // 2), max(1, small.height // 2)))
        if previous is not None:
            diff = ImageChops.difference(small, previous).point(lambda v: 255 if v > PIXEL_DELTA else 0)
            scores.append(ImageStat.Stat(diff).mean[0] / 255)
        previous = small
    return scores


def bursts(scores: list[float], times: list[float | None]) -> list[tuple[int, int]]:
    """Runs of moving frames, merging runs separated by short quiet gaps.

    Recorders on the hosted VM emit variable-rate video (a frame only when
    the screen changes), so a gap is measured in time as well as in frames.
    """
    runs: list[list[int]] = []
    for index, score in enumerate(scores):
        if score < MOTION_THRESHOLD:
            continue
        last = runs[-1][1] if runs else None
        close_in_time = (last is None or times[index] is None or times[last] is None
                         or times[index] - times[last] <= QUIET_SECONDS)
        if last is not None and index - last <= QUIET_GAP and close_in_time:
            runs[-1][1] = index
        else:
            runs.append([index, index])
    return [(start, end) for start, end in runs]


def font(size: int) -> ImageFont.ImageFont:
    for candidate in ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SFNSMono.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def sheet(frames: list[Path], indices: list[int], times: list[float | None], scores: list[float], out: Path, title: str) -> None:
    """One column of frames, each labelled with index, timestamp and motion."""
    images = [Image.open(frames[i]).convert("RGB") for i in indices]
    width = max(image.width for image in images)
    label_h = 18
    header_h = 26
    height = header_h + sum(image.height + label_h for image in images)
    canvas = Image.new("RGB", (width, height), (24, 24, 24))
    draw = ImageDraw.Draw(canvas)
    draw.text((6, 5), title, fill=(255, 255, 255), font=font(14))
    y = header_h
    small = font(12)
    for index, image in zip(indices, images):
        stamp = times[index]
        label = f"frame {index + 1:05d}" + (f"  t={stamp:.3f}s" if stamp is not None else "") + f"  changed={scores[index] * 100:.2f}%"
        draw.text((6, y + 2), label, fill=(255, 220, 120), font=small)
        y += label_h
        canvas.paste(image, (0, y))
        y += image.height
    canvas.save(out)


def evenly(candidates: list[int], count: int) -> list[int]:
    if len(candidates) <= count:
        return candidates
    step = (len(candidates) - 1) / (count - 1)
    return sorted({candidates[round(i * step)] for i in range(count)})


def sheets(frames_dir: str, out_dir: str) -> dict:
    directory = Path(frames_dir)
    target = Path(out_dir)
    target.mkdir(parents=True, exist_ok=True)
    frames = sorted(directory.glob("*.png"))
    if not frames:
        raise SystemExit(f"no frames in {frames_dir}")
    times = read_times(directory, len(frames))
    scores = motion(frames)
    runs = bursts(scores, times)
    # The overview samples the moving frames (plus the first and last) so
    # pauses between inputs do not fill the sheet with identical images.
    moving = sorted({0, len(frames) - 1, *[i for start, end in runs for i in range(start, end + 1)]})
    overview = target / "overview-sheet.png"
    sheet(frames, evenly(moving, OVERVIEW_FRAMES), times, scores, overview,
          f"{directory.name}: {len(frames)} frames, {len(runs)} motion bursts (evenly sampled)")
    written = [str(overview)]
    for number, (start, end) in enumerate(runs[:MAX_BURSTS], start=1):
        first = max(0, start - 2)
        last = min(len(frames), end + 4, first + BURST_FRAMES)
        path = target / f"burst-{number:02d}-sheet.png"
        sheet(frames, list(range(first, last)), times, scores, path,
              f"{directory.name} burst {number}: consecutive frames {first + 1}-{last}")
        written.append(str(path))
    return {
        "frames": len(frames),
        "bursts": [{"start": s + 1, "end": e + 1} for s, e in runs],
        "sheets": written,
        "timed": times[0] is not None,
    }


INSPECT_ZOOM = 4


def inspect(source: str, out_dir: str, prefix: str, crops_json: str) -> dict:
    """Magnify small regions without smoothing, so single-pixel steps stay visible."""
    image = Image.open(source).convert("RGB")
    target = Path(out_dir)
    target.mkdir(parents=True, exist_ok=True)
    files: list[str] = []
    tiles: list[tuple[str, Image.Image]] = []
    for crop_spec in json.loads(crops_json):
        x, y = max(0, crop_spec["x"]), max(0, crop_spec["y"])
        box = (x, y, min(image.width, crop_spec["x"] + crop_spec["width"]), min(image.height, crop_spec["y"] + crop_spec["height"]))
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        tile = image.crop(box)
        tile = tile.resize((tile.width * INSPECT_ZOOM, tile.height * INSPECT_ZOOM), Image.Resampling.NEAREST)
        path = target / f"{prefix}-{crop_spec['name']}.png"
        tile.save(path)
        files.append(str(path))
        tiles.append((f"{crop_spec['name']}  src={box[0]},{box[1]} {box[2] - box[0]}x{box[3] - box[1]}px  x{INSPECT_ZOOM}", tile))
    if tiles:
        label_h, gap = 20, 8
        width = max(tile.width for _, tile in tiles)
        height = sum(tile.height + label_h + gap for _, tile in tiles)
        canvas = Image.new("RGB", (width, height), (24, 24, 24))
        draw = ImageDraw.Draw(canvas)
        y = 0
        for label, tile in tiles:
            draw.text((6, y + 3), label, fill=(255, 220, 120), font=font(13))
            y += label_h
            canvas.paste(tile, (0, y))
            y += tile.height + gap
        sheet_path = target / f"{prefix}-sheet.png"
        canvas.save(sheet_path)
        files.append(str(sheet_path))
    return {"files": files}


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        raise SystemExit(__doc__)
    command, args = argv[1], argv[2:]
    if command == "wallpaper":
        emit(wallpaper(args[0], int(args[1]), int(args[2])))
    elif command == "stats":
        emit(stats(args[0]))
    elif command == "crop":
        emit(crop(args[0], args[1], *[int(round(float(v))) for v in args[2:6]]))
    elif command == "sheets":
        emit(sheets(args[0], args[1]))
    elif command == "inspect":
        emit(inspect(args[0], args[1], args[2], args[3]))
    else:
        raise SystemExit(f"unknown command {command}\n{__doc__}")


if __name__ == "__main__":
    main(sys.argv)
