# Crop UI fixtures

`generate.py` creates synthetic quadrant images with a transparent center using
Python zlib, FFmpeg and libavif's `avifenc`. The ordinary images are 512×384;
ICNS contains independent 128×128 and 256×256 PNG representations. SVG contains
four vector quadrants and a white center. These input images are not screenshots.
BMP uses an explicit V4 alpha mask; the high byte of 32-bit BI_RGB is reserved
and is interpreted differently by Chromium and WebKit.

The native spec loads them through real Explorer capture/save commands, compares
the unchanged original bytes and decoded cropped pixels, and captures the live
editor and resulting preview when `IMAGE_CROP_SCREENSHOTS` is set. The test runner
requires no fixture encoders. Run it on an isolated display/profile.

`oriented.png` stores 512 × 384 pixels with EXIF orientation 6. Its crop coordinate
space is 384 × 512. `oriented-reference.png` independently rotates the original
PNG pixel rows clockwise and contains no orientation metadata. The native test
compares the saved region against that reference after zooming and scrolling.

`oriented.webp` contains the same baseline WebP pixels with EXIF orientation 6.
Its expected pixels come from rotating the untagged `quadrants.webp` in a canvas,
so the assertion does not depend on browser support for WebP orientation tags.

AVIF orientation and pixel-aspect tests reuse the codec fixtures under
`src-tauri/test_support/fixtures/`. The oriented image's independent reference
was decoded with the system libavif CLI. The tests check the editor's canonical
pixel grid, the actual saved rectangle and unchanged original bytes.
