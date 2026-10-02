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
# EXIF orientation6 rotates stored512×384 pixels to displayed384×512.
base = ROOT.joinpath("quadrants.png").read_bytes()
exif = bytes([73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0])
payload = b"eXIf" + exif
ROOT.joinpath("oriented.png").write_bytes(base[:33] + struct.pack(">I", len(exif)) + payload
    + struct.pack(">I", zlib.crc32(payload)) + base[33:])
for extension in ["jpg", "gif", "webp"]:
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(ROOT / "quadrants.png"),
                    "-frames:v", "1", "-threads", "1", str(ROOT / f"quadrants.{extension}")], check=True)
# Independent pixel permutation supplies the PNG orientation oracle.
base = ROOT.joinpath("quadrants.png").read_bytes()
raw = zlib.decompress(base[41:-16])
rows = bytearray()
for y in range(512):
    rows.append(0)
    for x in range(384):
        offset = (383 - x) * (1 + 512 * 4) + 1 + y * 4
        rows.extend(raw[offset:offset + 4])
def reference_chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
ROOT.joinpath("oriented-reference.png").write_bytes(b"\x89PNG\r\n\x1a\n"
    + reference_chunk(b"IHDR", struct.pack(">IIBBBBB", 384, 512, 8, 6, 0, 0, 0))
    + reference_chunk(b"IDAT", zlib.compress(rows)) + reference_chunk(b"IEND", b""))
webp = bytearray(ROOT.joinpath("quadrants.webp").read_bytes())
assert webp[12:16] == b"VP8X"
webp[20] |= 8
webp.extend(b"EXIF" + struct.pack("<I", len(exif)) + exif)
webp[4:8] = struct.pack("<I", len(webp) - 8)
ROOT.joinpath("oriented.webp").write_bytes(webp)
subprocess.run(["avifenc", "--jobs", "1", "--lossless", str(ROOT / "quadrants.png"),
                str(ROOT / "quadrants.avif")], check=True)
elements = []
for kind, size in [(b"ic07", 128), (b"ic08", 256)]:
    payload = png(size, size)
    elements.append(kind + struct.pack(">I", 8 + len(payload)) + payload)
body = b"".join(elements)
ROOT.joinpath("quadrants.icns").write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)
# Explicit BITMAPV4HEADER/BI_BITFIELDS alpha. The high byte in legacy 32-bit
# BI_RGB is reserved, and Chromium/WebKit disagree about interpreting it.
width, height = 512, 384
header = bytearray(108)
struct.pack_into("<IiiHHIIiiII", header, 0, 108, width, height, 1, 32, 3, width * height * 4, 0, 0, 0, 0)
struct.pack_into("<IIIII", header, 40, 0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000, 0x73524742)
pixels = bytearray()
colors = [(231, 76, 60), (46, 204, 113), (52, 152, 219), (241, 196, 15)]
for y in reversed(range(height)):
    for x in range(width):
        red, green, blue = colors[(x >= width // 2) + 2 * (y >= height // 2)]
        alpha = 0 if width * 0.40 <= x < width * 0.60 and height * 0.40 <= y < height * 0.60 else 255
        pixels.extend((blue, green, red, alpha))
ROOT.joinpath("quadrants.bmp").write_bytes(b"BM" + struct.pack("<IHHI", 14 + len(header) + len(pixels), 0, 0, 14 + len(header)) + header + pixels)
ROOT.joinpath("quadrants.svg").write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384">
<path fill="#e74c3c" d="M0 0H256V192H0Z"/><path fill="#2ecc71" d="M256 0H512V192H256Z"/>
<path fill="#3498db" d="M0 192H256V384H0Z"/><path fill="#f1c40f" d="M256 192H512V384H256Z"/>
<rect x="208" y="152" width="96" height="80" fill="white"/>
</svg>''')
