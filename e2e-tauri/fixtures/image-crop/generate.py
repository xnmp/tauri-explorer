"""Synthetic native UI inputs, independently encoded with zlib/FFmpeg/libavif.

Run manually to regenerate committed files; the native test needs no encoders.
These are test images, not acceptance screenshots.
"""
from pathlib import Path
import struct
import subprocess
import zlib

ROOT = Path(__file__).resolve().parent


def png(width, height):
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    rows = bytearray()
    colors = [(231, 76, 60), (46, 204, 113), (52, 152, 219), (241, 196, 15)]
    for y in range(height):
        rows.append(0)
        for x in range(width):
            color = colors[(x >= width // 2) + 2 * (y >= height // 2)]
            alpha = 0 if width * 0.40 <= x < width * 0.60 and height * 0.40 <= y < height * 0.60 else 255
            rows.extend((*color, alpha))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


ROOT.joinpath("quadrants.png").write_bytes(png(512, 384))
for extension in ["jpg", "bmp", "gif", "webp"]:
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(ROOT / "quadrants.png"),
                    "-frames:v", "1", "-threads", "1", str(ROOT / f"quadrants.{extension}")], check=True)
subprocess.run(["avifenc", "--jobs", "1", "--lossless", str(ROOT / "quadrants.png"),
                str(ROOT / "quadrants.avif")], check=True)
elements = []
for kind, size in [(b"ic07", 128), (b"ic08", 256)]:
    payload = png(size, size)
    elements.append(kind + struct.pack(">I", 8 + len(payload)) + payload)
body = b"".join(elements)
ROOT.joinpath("quadrants.icns").write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)
ROOT.joinpath("quadrants.svg").write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384">
<path fill="#e74c3c" d="M0 0H256V192H0Z"/><path fill="#2ecc71" d="M256 0H512V192H256Z"/>
<path fill="#3498db" d="M0 192H256V384H0Z"/><path fill="#f1c40f" d="M256 192H512V384H256Z"/>
<rect x="208" y="152" width="96" height="80" fill="white"/>
</svg>''')
