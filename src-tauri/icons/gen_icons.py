# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow"]
# ///
"""Regenerate platform icons and browser favicons from canonical icon.png."""

import io
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

icons_dir = Path(__file__).resolve().parent
repo_dir = icons_dir.parent.parent

# Tauri owns the platform-specific PNG sizes and mobile icon conventions.
# Generate into a temporary directory: its icon.png is a resized derivative,
# and must not overwrite our approved, full-resolution source artwork.
with tempfile.TemporaryDirectory(prefix="tauri-explorer-icons-") as output:
    subprocess.run(
        ["bun", "run", "tauri", "icon", str(icons_dir / "icon.png"), "--output", output],
        cwd=repo_dir,
        check=True,
    )
    for source in Path(output).rglob("*"):
        relative = source.relative_to(output)
        if not source.is_file() or relative == Path("icon.png"):
            continue
        destination = icons_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if relative.parts[0] == "ios" and source.suffix == ".png":
            # Tauri has already applied the iOS background, but may leave
            # alpha=254 rounding residues. Legacy AppIcon PNGs must be opaque.
            with Image.open(source) as mobile_icon:
                mobile_icon.convert("RGB").save(destination)
        else:
            shutil.copyfile(source, destination)

png = Image.open(icons_dir / "icon.png").convert("RGBA")

favicon = png.resize((64, 64), Image.LANCZOS)
for destination in [repo_dir / "static/favicon.png", repo_dir / "website/favicon.png"]:
    favicon.save(destination)
print("Generated application and website favicons")

# Generate .ico (Windows). Each sub-image is stored as PNG so the full
# alpha channel survives — Pillow's default BMP encoding for ICO sub-frames
# loses transparency on Windows and looks pixelated/whitewashed.
# The source art carries macOS-style padding (glyph fills ~77% of the canvas),
# which is the .icns convention but makes the Windows taskbar / title-bar icon
# read noticeably small next to other apps. Zoom the glyph in slightly for the
# .ico only (centered crop of a scaled copy) so it fills more of the frame. The
# .icns below keeps the original padding.
ICO_CONTENT_SCALE = 1.11
ico_sizes = [16, 32, 48, 64, 128, 256]
frames: list[tuple[int, bytes]] = []
for size in ico_sizes:
    inner = max(size, round(size * ICO_CONTENT_SCALE))
    scaled = png.resize((inner, inner), Image.LANCZOS)
    left = (inner - size) // 2
    frame = scaled.crop((left, left, left + size, left + size))
    buf = io.BytesIO()
    frame.save(buf, format="PNG")
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

# Generate .icns (macOS). icon.png carries pre-Tahoe padding (tile at ~77%
# of a transparent canvas); since macOS 26 the system tiles that padded art
# onto a grey squircle backing, shrunken. The correct look — confirmed by
# manually applying the Square*Logo art via Get Info — is the tile at nearly
# full frame with ITS OWN silhouette (rounded corners, tab, transparency
# outside), matching the Square*Logo framing. Crop to the opaque tile's
# alpha bounding box (soft shadow excluded from the measure, clipped to the
# margin like the Square logos) plus a small margin, alpha preserved.
ICNS_MARGIN = 0.03
alpha_bbox = png.getchannel("A").point(lambda a: 255 if a > 200 else 0).getbbox()
bw, bh = alpha_bbox[2] - alpha_bbox[0], alpha_bbox[3] - alpha_bbox[1]
side = round(max(bw, bh) * (1 + 2 * ICNS_MARGIN))
cx, cy = (alpha_bbox[0] + alpha_bbox[2]) // 2, (alpha_bbox[1] + alpha_bbox[3]) // 2
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(png, (side // 2 - cx, side // 2 - cy), png)

icns_sizes = [16, 32, 64, 128, 256, 512, 1024]
icns_images = [canvas.resize((s, s), Image.LANCZOS) for s in icns_sizes]
icns_images[0].save(icons_dir / "icon.icns", format="ICNS", append_images=icns_images[1:])
canvas.resize((512, 512), Image.LANCZOS).save(icons_dir / "icns-preview.png")
print("Generated icon.icns (Square-logo framing) + icns-preview.png")
