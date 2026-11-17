# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow", "numpy"]
# ///
"""Derive canonical icon.png from icon-aperture.png by filling the tau (#1553).

The approved #1231 artwork renders the Greek tau as a transparent aperture in
the jade folder, so it shows whatever is behind the icon (black taskbars,
coloured wallpapers). #1553 asked for a filled tau. This script locates the
enclosed transparent region (alpha < 128, connected, not touching the canvas
border) and composites the source over a solid pale-jade fill inside it:

* deep interior pixels (more than ERODE px from the opaque folder) become the
  pure fill, so faint background-removal specks inside the aperture vanish;
* the rim (the aperture grown by GROW px, minus that interior) is the source
  composited "over" the fill, so the folder's antialiased edge blends into the
  fill without a dark or transparent halo.

The fill is an engraved letter (#1732), not a flat sticker: a vertical
gradient from near-white at the top of the tau to the folder tab's mint at its
foot, darkened by a soft inner shadow that falls from the tau's top edges (the
folder's own coverage, shifted down and blurred), so the glyph reads as cut
into the folder surface. The shadow is painted on the fill *beneath* the
source, so it only shows through the aperture and never touches the folder.

Pixels outside the aperture's rim are untouched. From the repository root:

    uv run src-tauri/icons/fill_tau.py && uv run src-tauri/icons/gen_icons.py
"""

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

icons_dir = Path(__file__).resolve().parent
SOURCE = icons_dir / "icon-aperture.png"
OUTPUT = icons_dir / "icon.png"

# Engraved fill: near-white (tinted jade, not a stark sticker-white) at the top
# of the tau, easing into the folder tab's mint at its foot.
FILL_TOP = (240, 254, 249)
FILL_BOTTOM = (125, 239, 212)  # the folder tab's face colour
# Gradient easing exponent (>1 keeps the upper stroke light for legibility).
GRADIENT_EASE = 1.6
# Inner shadow, in pixels of the 1254px source: how far the folder's edge is
# dropped down over the tau, how soft it is, and how dark it gets at most.
SHADOW_OFFSET = 14
SHADOW_BLUR = 12
SHADOW_STRENGTH = 0.42
SHADOW_COLOUR = (0, 72, 92)  # deep teal, so the recess is tinted, not grey
APERTURE_ALPHA = 128
ERODE = 3
GROW = 4


def enclosed_aperture(image: Image.Image) -> Image.Image:
    """Largest transparent component that does not touch the canvas border."""
    w, h = image.size
    alpha = image.getchannel("A").tobytes()
    transparent = bytearray(1 if a < APERTURE_ALPHA else 0 for a in alpha)
    seen = bytearray(w * h)
    best: list[int] = []
    for start in range(w * h):
        if not transparent[start] or seen[start]:
            continue
        seen[start] = 1
        queue, component, touches_border = deque([start]), [], False
        while queue:
            i = queue.popleft()
            component.append(i)
            x, y = i % w, i // w
            if x in (0, w - 1) or y in (0, h - 1):
                touches_border = True
            neighbours = (i - 1 if x else -1, i + 1 if x < w - 1 else -1, i - w, i + w)
            for j in neighbours:
                if 0 <= j < w * h and transparent[j] and not seen[j]:
                    seen[j] = 1
                    queue.append(j)
        if not touches_border and len(component) > len(best):
            best = component
    if not best:
        raise SystemExit("no enclosed transparent aperture found")
    mask = bytearray(w * h)
    for i in best:
        mask[i] = 255
    return Image.frombytes("L", (w, h), bytes(mask))


def engraved_fill(source: Image.Image, aperture: Image.Image) -> Image.Image:
    """Opaque gradient fill with an inner shadow cast by the folder above the tau."""
    w, h = source.size
    top, bottom = aperture.getbbox()[1], aperture.getbbox()[3]
    t = np.clip((np.arange(h, dtype=np.float64) - top) / max(1, bottom - top), 0, 1)
    t = t**GRADIENT_EASE
    gradient = (
        np.array(FILL_TOP, dtype=np.float64)[None, :] * (1 - t)[:, None]
        + np.array(FILL_BOTTOM, dtype=np.float64)[None, :] * t[:, None]
    )
    rgb = np.broadcast_to(gradient[:, None, :], (h, w, 3)).copy()

    # The folder's coverage (its alpha) is everything that is not the tau;
    # dropping it down and blurring it gives the shadow its top edge casts.
    cover = source.getchannel("A")
    dropped = Image.new("L", source.size, 255)
    dropped.paste(cover.crop((0, 0, w, h - SHADOW_OFFSET)), (0, SHADOW_OFFSET))
    shadow = np.asarray(dropped.filter(ImageFilter.GaussianBlur(SHADOW_BLUR)), dtype=np.float64)
    shadow = (shadow / 255.0 * SHADOW_STRENGTH)[..., None]
    rgb = rgb * (1 - shadow) + np.array(SHADOW_COLOUR, dtype=np.float64) * shadow

    alpha = np.full((h, w, 1), 255.0)
    pixels = np.concatenate([rgb, alpha], axis=2)
    return Image.fromarray(np.round(pixels).astype(np.uint8), "RGBA")


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    aperture = enclosed_aperture(source)
    interior = aperture.filter(ImageFilter.MinFilter(2 * ERODE + 1))
    rim = aperture.filter(ImageFilter.MaxFilter(2 * GROW + 1))

    fill = engraved_fill(source, aperture)
    over_fill = Image.alpha_composite(fill, source)  # source over opaque fill

    result = Image.composite(over_fill, source, rim)
    result = Image.composite(fill, result, interior)
    result.save(OUTPUT)
    print(f"Engraved the tau aperture of {SOURCE.name} -> {OUTPUT.name}")


if __name__ == "__main__":
    main()
