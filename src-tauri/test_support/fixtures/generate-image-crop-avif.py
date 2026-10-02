"""Regenerate synthetic AVIF inputs with independent system libavif1.4.2 tools.

Requires avifenc, avifdec, pkg-config, a C compiler and installed libavif headers.
The committed valid sRGB ICC profile is reused. No production crop code is linked.
"""
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib
import shlex

ROOT = Path(__file__).resolve().parent


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def png(path, frame=0, depth=8):
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    rows = bytearray()
    for y in range(12):
        rows.append(0)
        for x in range(16):
            values = ((x * 13, (y * 19 + frame * 31) % 256, 83 + frame * 11, 64 if x % 3 == 0 else 255)
                      if depth == 8 else (x * 3801, y * 5101, 23456, 30001 if x % 3 == 0 else 65535))
            rows.extend(bytes(values) if depth == 8 else struct.pack(">4H", *values))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 12, depth, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def derive_sequence(source, one_frame):
    data = bytearray(source)
    counts = {}
    def shorten(offset, payload, old_size):
        size = 8 + len(payload)
        padding = old_size - size
        assert padding >= 8
        kind = bytes(data[offset + 4:offset + 8])
        data[offset:offset + old_size] = (struct.pack(">I4s", size, kind) + payload
                                         + struct.pack(">I4s", padding, b"free") + bytes(padding - 8))
    def walk(start, end):
        offset = start
        while offset < end:
            size, kind = struct.unpack_from(">I4s", data, offset)
            assert size >= 8 and offset + size <= end
            payload = offset + 8
            counts[kind] = counts.get(kind, 0) + 1
            if not one_frame and kind == b"edts":
                data[offset + 4:offset + 8] = b"free"
            elif kind in (b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts"):
                walk(payload, offset + size)
            elif one_frame:
                if kind == b"stts":
                    assert struct.unpack_from(">I", data, payload + 4)[0] == 3
                    shorten(offset, bytes(4) + struct.pack(">III", 1, 1, 7), size)
                elif kind == b"stsz":
                    assert struct.unpack_from(">II", data, payload + 4) == (0, 3)
                    first = struct.unpack_from(">I", data, payload + 12)[0]
                    shorten(offset, bytes(8) + struct.pack(">II", 1, first), size)
                elif kind == b"stsc":
                    assert struct.unpack_from(">I", data, payload + 4)[0] == 1
                    struct.pack_into(">I", data, payload + 12, 1)
                elif kind == b"stss":
                    assert struct.unpack_from(">II", data, payload + 4) == (1, 1)
                elif kind in (b"mvhd", b"tkhd", b"mdhd", b"elst"):
                    assert data[payload] == 1
                    position = {b"mvhd": 24, b"tkhd": 28, b"mdhd": 24, b"elst": 8}[kind]
                    duration = 21 if kind in (b"mvhd", b"tkhd") else 7
                    struct.pack_into(">Q", data, payload + position, duration)
            offset += size
        assert offset == end
    walk(0, len(data))
    assert counts[b"edts"] == 2
    return data


def promote_clean_aperture(path):
    data = bytearray(path.read_bytes())
    found = []
    associations = []
    property_index = 0
    def walk(start, end, in_properties=False):
        nonlocal property_index
        offset = start
        while offset < end:
            size, kind = struct.unpack_from(">I4s", data, offset)
            assert size >= 8 and offset + size <= end
            if in_properties:
                property_index += 1
            if in_properties and kind == b"crop":
                assert size == 40
                assert struct.unpack_from(">8I", data, offset + 8) == (12, 1, 8, 1, 0, 1, 0xffffffff, 1)
                data[offset + 4:offset + 8] = b"clap"
                found.append(property_index)
            elif kind == b"ipma":
                associations.append((offset + 8, offset + size))
            elif kind in (b"meta", b"iprp", b"ipco"):
                walk(offset + (12 if kind == b"meta" else 8), offset + size, kind == b"ipco")
            offset += size
        assert offset == end
    walk(0, len(data))
    assert len(found) == 1  # The identical base/gain property is deduplicated.
    marked = 0
    for start, end in associations:
        version = data[start]
        flags = int.from_bytes(data[start + 1:start + 4], "big")
        assert version in (0, 1) and flags in (0, 1)
        entries = struct.unpack_from(">I", data, start + 4)[0]
        position = start + 8
        for _ in range(entries):
            position += 2 if version == 0 else 4
            count = data[position]
            position += 1
            length = 2 if flags & 1 else 1
            essential = 0x8000 if length == 2 else 0x80
            for _ in range(count):
                assert position + length <= end
                association = int.from_bytes(data[position:position + length], "big")
                if association & (essential - 1) == found[0]:
                    data[position:position + length] = (association | essential).to_bytes(length, "big")
                    marked += 1
                position += length
        assert position == end
    assert marked >= 2  # At least the base and gain image reference the aperture.
    path.write_bytes(data)


def main():
    assert "1.4.2" in run("avifenc", "--version")
    assert "1.4.2" in run("avifdec", "--version")
    with tempfile.TemporaryDirectory(prefix="crop-avif-fixtures-") as temporary:
        folder = Path(temporary)
        frames = [folder / f"frame{index}.png" for index in range(3)]
        for index, path in enumerate(frames):
            png(path, index)
        hdr = folder / "hdr.png"
        png(hdr, depth=16)
        def encode(name, *arguments):
            run("avifenc", "--codec", "aom", "--jobs", "2", "--speed", "10", "--lossless",
                *map(str, arguments), str(ROOT / f"image-crop-{name}.avif"))
        encode("static", "--icc", ROOT / "image-crop-srgb.icc", frames[0])
        encode("hdr", "--depth", "12", "--cicp", "9/16/0", "--clli", "3000,1000", hdr)
        encode("sixteen-bit", "--depth", "8,8", "--cicp", "9/16/0", hdr)
        encode("animation", "--timescale", "100", "--repetition-count", "2",
               "--duration", "7", frames[0], "--duration", "12", frames[1], "--duration", "15", frames[2])
        encode("oriented", "--crop", "2,1,12,8", "--irot", "1", "--imir", "1", frames[0])
        encode("aspect", "--pasp", "2,1", "--irot", "1", frames[0])
        run("avifdec", "--jobs", "2", str(ROOT / "image-crop-oriented.avif"), str(ROOT / "image-crop-oriented-reference.png"))
        animation = (ROOT / "image-crop-animation.avif").read_bytes()
        for name, one in [("unknown-loops", False), ("one-frame-sequence", True)]:
            (ROOT / f"image-crop-{name}.avif").write_bytes(derive_sequence(animation, one))
        flags = shlex.split(run("pkg-config", "--cflags", "--libs", "libavif"))
        executable = folder / "generate-gain-map"
        run("cc", "-std=c11", "-Wall", "-Wextra", "-Werror", str(ROOT / "generate-image-crop-gain-map.c"),
            *flags, "-o", str(executable))
        run(str(executable), str(ROOT / "image-crop-gain-map.avif"))
        for mode in ["oriented", "subsampled", "icc"]:
            args = [str(executable), str(ROOT / f"image-crop-gain-map-{mode}.avif"), mode]
            if mode == "icc":
                args.append(str(ROOT / "image-crop-srgb.icc"))
            run(*args)
            if mode == "oriented":
                promote_clean_aperture(ROOT / "image-crop-gain-map-oriented.avif")
    for path in sorted(ROOT.glob("image-crop-*.avif")):
        print(path.name)
        print(run("avifdec", "--jobs", "2", "--info", str(path)))


if __name__ == "__main__":
    main()
