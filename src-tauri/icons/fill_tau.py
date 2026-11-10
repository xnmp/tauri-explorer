# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow"]
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

Pixels outside the aperture's rim are untouched. From the repository root:

    uv run src-tauri/icons/fill_tau.py && uv run src-tauri/icons/gen_icons.py
"""

from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

icons_dir = Path(__file__).resolve().parent
SOURCE = icons_dir / "icon-aperture.png"
OUTPUT = icons_dir / "icon.png"

# Pale jade: lighter than the folder's lightest (tab) face so the glyph reads
# as a solid letter, yet tinted so it is not a stark sticker-white.
FILL = (236, 253, 246)
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


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    aperture = enclosed_aperture(source)
    interior = aperture.filter(ImageFilter.MinFilter(2 * ERODE + 1))
    rim = aperture.filter(ImageFilter.MaxFilter(2 * GROW + 1))

    fill = Image.new("RGBA", source.size, FILL + (255,))
    over_fill = Image.alpha_composite(fill, source)  # source over opaque fill

    result = Image.composite(over_fill, source, rim)
    result = Image.composite(fill, result, interior)
    result.save(OUTPUT)
    print(f"Filled the tau aperture of {SOURCE.name} -> {OUTPUT.name}")


if __name__ == "__main__":
    main()
