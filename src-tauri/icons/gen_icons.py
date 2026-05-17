# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow"]
# ///
"""Generate .ico and .icns from icon.png"""

import io
import struct
from pathlib import Path

from PIL import Image

icons_dir = Path(__file__).parent
png = Image.open(icons_dir / "icon.png").convert("RGBA")

# Generate .ico (Windows). Each sub-image is stored as PNG so the full
# alpha channel survives — Pillow's default BMP encoding for ICO sub-frames
# loses transparency on Windows and looks pixelated/whitewashed.
ico_sizes = [16, 32, 48, 64, 128, 256]
frames: list[tuple[int, bytes]] = []
for size in ico_sizes:
    buf = io.BytesIO()
    png.resize((size, size), Image.LANCZOS).save(buf, format="PNG")
    frames.append((size, buf.getvalue()))

with (icons_dir / "icon.ico").open("wb") as f:
    f.write(struct.pack("<HHH", 0, 1, len(frames)))  # reserved, type=ICO, count
    offset = 6 + 16 * len(frames)
    for size, data in frames:
        dim = 0 if size >= 256 else size  # 0 in the ICO header means 256
        f.write(
            struct.pack(
                "<BBBBHHII",
                dim, dim,  # width, height
                0, 0,      # color count, reserved
                1, 32,     # planes, bits-per-pixel
                len(data), offset,
            )
        )
        offset += len(data)
    for _, data in frames:
        f.write(data)
print("Generated icon.ico")

# Generate .icns (macOS) - Pillow supports saving as ICNS
icns_sizes = [16, 32, 64, 128, 256, 512]
icns_images = [png.resize((s, s), Image.LANCZOS) for s in icns_sizes]
icns_images[0].save(icons_dir / "icon.icns", format="ICNS", append_images=icns_images[1:])
print("Generated icon.icns")
