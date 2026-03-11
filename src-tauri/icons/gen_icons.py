# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow"]
# ///
"""Generate .ico and .icns from icon.png"""

from PIL import Image
from pathlib import Path

icons_dir = Path(__file__).parent
png = Image.open(icons_dir / "icon.png")

# Generate .ico (Windows) - multiple sizes embedded
ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ico_images = [png.resize(s, Image.LANCZOS) for s in ico_sizes]
ico_images[0].save(icons_dir / "icon.ico", format="ICO", sizes=ico_sizes, append_images=ico_images[1:])
print("Generated icon.ico")

# Generate .icns (macOS) - Pillow supports saving as ICNS
icns_sizes = [16, 32, 64, 128, 256, 512]
icns_images = [png.resize((s, s), Image.LANCZOS) for s in icns_sizes]
icns_images[0].save(icons_dir / "icon.icns", format="ICNS", append_images=icns_images[1:])
print("Generated icon.icns")
