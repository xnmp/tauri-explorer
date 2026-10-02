# Crop UI fixtures

`generate.py` creates synthetic quadrant images with a transparent center using
Python zlib, FFmpeg and libavif's `avifenc`. The ordinary images are 512×384;
ICNS contains independent 128×128 and 256×256 PNG representations. SVG contains
four vector quadrants and a white center. These input images are not screenshots.

The native spec loads them through real Explorer capture/save commands, compares
the unchanged original bytes and decoded cropped pixels, and captures the live
editor and resulting preview when `IMAGE_CROP_SCREENSHOTS` is set. The test runner
requires no fixture encoders. Run it on an isolated display/profile.
