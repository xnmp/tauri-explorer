# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow", "numpy", "scipy"]
# ///
"""Regenerate platform icons and browser favicons from canonical icon.png.

Every platform except macOS uses the standalone folder exactly as drawn in
icon.png (transparent outside its silhouette). macOS gets its own artwork,
the "raised folder squircle" (#1732): since macOS 26 the Dock and Finder put
any legacy ICNS art that does not fill Apple's squircle onto a grey tile, so
the ICNS is an opaque superellipse tile on Apple's icon grid instead. See
README.md for why this is not an Icon Composer asset.
"""

import io
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

icons_dir = Path(__file__).resolve().parent
repo_dir = icons_dir.parent.parent

# ICO_CONTENT_SCALE zooms the glyph for the .ico only (centered crop of a
# scaled copy). It was 1.11, which stretched the folder to ~96% of each frame
# so it read oversized in the Windows taskbar and title bar next to other apps
# (#1553). At 1.0 the folder spans ~86% of the frame, matching the Windows
# icon keyline (28/32 = 87.5%), and the filled tau (#1553) already adds visual
# weight at small sizes. tests/app-icon.test.ts bounds this value.
ICO_CONTENT_SCALE = 1.0
ICO_SIZES = [16, 32, 48, 64, 128, 256]

# macOS squircle geometry: Apple's macOS icon grid is a 1024 canvas with an
# 824 tile centred on it (100 px clear on every side). Apple's continuous
# corner is closely approximated by a superellipse |x|^n + |y|^n = 1, n = 5.
# tests/app-icon.test.ts checks the generated ic10 frame against these values.
SQUIRCLE_CANVAS = 1024
SQUIRCLE_TILE = 824
SQUIRCLE_EXPONENT = 5.0
# The shorter side of the folder's alpha bounding box is scaled to this
# fraction of the tile, so every face (and the tab's top) runs a few pixels
# under the squircle edge, inside the rim, and is clipped by it.
SQUIRCLE_FOLDER_FILL = 1.02
# Pixels of antialiased folder edge kept when compositing over the tile
# (anything further out is the art's soft drop shadow, which is dropped).
SQUIRCLE_EDGE_AA = 2.0
# How far inside the silhouette faces are sampled to continue them into the
# corner gaps, and how far in from the tile edge gaps are told apart.
SQUIRCLE_SEAM = 4
# Deep teal, darker than the folder's deepest (bottom) face, so the notch
# beside the tab reads as the tile showing through rather than another face.
SQUIRCLE_NOTCH_TOP = (6, 92, 112)
SQUIRCLE_NOTCH_BOTTOM = (3, 66, 86)
# Rounded rim: a height field rising over SQUIRCLE_RIM px from the tile edge
# with a quarter-circle profile, shaded by a light from above. Highlights and
# shade come only from the relief's normals, so the edge reads as raised
# rather than outlined by a stroke.
SQUIRCLE_RIM = 30.0
SQUIRCLE_LIGHT = (0.0, -1.0, 1.6)  # (x right, y down, z towards viewer)
SQUIRCLE_HIGHLIGHT = 0.85
SQUIRCLE_SHADE = 0.55


def regenerate_tauri_assets() -> None:
    """Desktop PNG sizes, Windows Store logos, Android and iOS via `tauri icon`.

    Generate into a temporary directory: its icon.png is a resized
    derivative and must not overwrite the approved full-resolution artwork.
    Its icon.ico and icon.icns are replaced below.
    """
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


def write_favicons(art: Image.Image) -> None:
    favicon = art.resize((64, 64), Image.LANCZOS)
    for destination in [repo_dir / "static/favicon.png", repo_dir / "website/favicon.png"]:
        favicon.save(destination)
    print("Generated application and website favicons")


def write_ico(art: Image.Image) -> None:
    """Windows .ico of the standalone folder, every frame PNG-encoded.

    Pillow's default BMP encoding for ICO sub-frames loses transparency on
    Windows and looks pixelated/whitewashed.
    """
    frames: list[tuple[int, bytes]] = []
    for size in ICO_SIZES:
        inner = max(size, round(size * ICO_CONTENT_SCALE))
        scaled = art.resize((inner, inner), Image.LANCZOS)
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


def squircle_signed_distance(size: int, tile: int, exponent: float) -> np.ndarray:
    """Approximate signed distance (px, negative inside) to the centred tile edge.

    The superellipse's level-set function r = (|x|^n + |y|^n)^(1/n) is a norm,
    so (r - a) / |grad r| is a first-order distance estimate that is exact on
    the axes and within a fraction of a pixel near the edge everywhere else,
    which is all antialiasing and a narrow rim need.
    """
    half = tile / 2
    coords = np.arange(size, dtype=np.float64) + 0.5 - size / 2
    x = np.abs(coords)[None, :]
    y = np.abs(coords)[:, None]
    n = exponent
    r = (x**n + y**n) ** (1 / n)
    safe_r = np.maximum(r, 1e-9)
    gx = (x / safe_r) ** (n - 1)
    gy = (y / safe_r) ** (n - 1)
    gradient = np.maximum(np.hypot(gx, gy), 1e-9)
    return (r - half) / gradient


def folder_on_tile(art: Image.Image, size: int, tile: int, distance: np.ndarray) -> np.ndarray:
    """The folder art filling the tile, as float RGB (size x size x 3).

    The folder silhouette leaves gaps inside the tile: the notch beside the
    tab (the largest one) and the chamfered corners. The notch is painted
    deep teal so the tab still reads as a tab; the corner gaps continue the
    nearest folder face outwards so the faces run under the squircle edge.
    The folder's soft drop shadow is dropped: on an opaque tile it would only
    smudge the gaps.
    """
    bbox = art.getchannel("A").point(lambda a: 255 if a > 200 else 0).getbbox()
    scale = tile * SQUIRCLE_FOLDER_FILL / min(bbox[2] - bbox[0], bbox[3] - bbox[1])
    scaled = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
    placed = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    centre_x = (bbox[0] + bbox[2]) / 2 * scale
    centre_y = (bbox[1] + bbox[3]) / 2 * scale
    placed.alpha_composite(scaled, (round(size / 2 - centre_x), round(size / 2 - centre_y)))
    folder = np.asarray(placed, dtype=np.float64)
    rgb, alpha = folder[..., :3], folder[..., 3:] / 255

    core = alpha[..., 0] > 0.97
    # Antialiased edge only: anything further out is the drop shadow.
    alpha = np.where(ndimage.distance_transform_edt(~core)[..., None] > SQUIRCLE_EDGE_AA, 0.0, alpha)
    # Continue each face from a few pixels inside the silhouette, so the art's
    # darker antialiased outline is not smeared outwards into the gaps.
    deep = ndimage.binary_erosion(core, iterations=SQUIRCLE_SEAM)
    _, (iy, ix) = ndimage.distance_transform_edt(~deep, return_indices=True)
    extended = ndimage.gaussian_filter(rgb[iy, ix], (2.0, 2.0, 0))

    # Gaps inside the tile (a little in from its edge, so a folder face that
    # merely grazes the edge cannot join two gaps through the rim).
    inside = distance < -SQUIRCLE_SEAM
    labels, count = ndimage.label(inside & ~core)
    sizes = ndimage.sum_labels(np.ones_like(labels), labels, range(1, count + 1))
    notch = labels == 1 + int(np.argmax(sizes)) if count else np.zeros_like(core)
    corners = (labels > 0) & ~notch

    top = (size - tile) / 2
    t = np.clip((np.arange(size) + 0.5 - top) / tile, 0, 1)[:, None, None]
    teal = np.array(SQUIRCLE_NOTCH_TOP) * (1 - t) + np.array(SQUIRCLE_NOTCH_BOTTOM) * t
    # The notch keeps the folder's edge (the tab and body read as cut out
    # against it); everywhere else the folder sits over its own extension.
    in_notch = ndimage.gaussian_filter(
        ndimage.binary_dilation(notch, iterations=SQUIRCLE_SEAM).astype(np.float64), 1.0
    )[..., None]
    under = extended * (1 - in_notch) + np.broadcast_to(teal, extended.shape) * in_notch
    tiled = rgb * alpha + under * (1 - alpha)
    # At the chamfered corners the faces run on under the squircle edge: the
    # folder's silhouette (and its outline) is replaced by the extension.
    seam = ndimage.binary_dilation(corners, iterations=2 * SQUIRCLE_SEAM) & ~notch
    in_corner = ndimage.gaussian_filter(seam.astype(np.float64), 1.5)[..., None]
    return tiled * (1 - in_corner) + extended * in_corner


def raised_rim(rgb: np.ndarray, inside_distance: np.ndarray) -> np.ndarray:
    """Shade a rounded rim from a height field lit from above."""
    d = np.clip(inside_distance / SQUIRCLE_RIM, 0, 1)
    height = SQUIRCLE_RIM * np.sqrt(1 - (1 - d) ** 2)  # quarter-circle shoulder
    height = ndimage.gaussian_filter(height, 1.2)  # tame the vertical tangent at the edge
    dy, dx = np.gradient(height)
    normal = np.stack([-dx, -dy, np.ones_like(height)], axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    light = np.array(SQUIRCLE_LIGHT) / np.linalg.norm(SQUIRCLE_LIGHT)
    # Relative to a flat face, so the interior is untouched.
    lit = normal @ light - light[2]
    lit = lit[..., None]
    highlight = np.clip(lit, 0, None) * SQUIRCLE_HIGHLIGHT
    shade = np.clip(-lit, 0, None) * SQUIRCLE_SHADE
    rgb = rgb + (255 - rgb) * highlight
    return rgb * (1 - shade)


def macos_squircle(art: Image.Image) -> Image.Image:
    """The opaque "raised folder squircle" ICNS artwork at SQUIRCLE_CANVAS px."""
    size, tile = SQUIRCLE_CANVAS, SQUIRCLE_TILE
    distance = squircle_signed_distance(size, tile, SQUIRCLE_EXPONENT)
    rgb = raised_rim(folder_on_tile(art, size, tile, distance), -distance)
    coverage = np.clip(0.5 - distance, 0, 1)  # one-pixel antialiased edge
    pixels = np.concatenate([np.clip(rgb, 0, 255), coverage[..., None] * 255], axis=-1)
    return Image.fromarray(np.round(pixels).astype(np.uint8), "RGBA")


def write_icns(art: Image.Image) -> None:
    squircle = macos_squircle(art)
    icns_sizes = [16, 32, 64, 128, 256, 512]
    icns_images = [squircle.resize((s, s), Image.LANCZOS) for s in icns_sizes] + [squircle]
    icns_images[0].save(icons_dir / "icon.icns", format="ICNS", append_images=icns_images[1:])
    squircle.resize((512, 512), Image.LANCZOS).save(icons_dir / "icns-preview.png")
    print("Generated icon.icns (raised folder squircle) + icns-preview.png")


def main() -> None:
    regenerate_tauri_assets()
    art = Image.open(icons_dir / "icon.png").convert("RGBA")
    write_favicons(art)
    write_ico(art)
    write_icns(art)


if __name__ == "__main__":
    main()
