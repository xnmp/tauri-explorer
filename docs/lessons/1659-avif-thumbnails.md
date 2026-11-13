# #1659 — AVIF thumbnails missing in release builds

**Symptom:** AVIF files showed generic icons in Tiles/thumbnail views on the
released Linux build, although the preview pane rendered them.

**Cause:** Thumbnail support for `.avif` was gated on the optional `avif`
cargo feature (image's dav1d-backed `avif-native` decoder), which only the Arch
PKGBUILD enables. Release builds therefore rejected AVIF as an unsupported
thumbnail format. The preview pane and crop editor already decoded AVIF through
the always-built, vendored `explorer_avif` decoder.

**Fix:** `thumbnails.rs` decodes AVIF through `explorer_avif::decode_frame`
(first frame, orientation applied, 10/12-bit rescaled to 16-bit) in every
build, so thumbnails and the preview pane share one decoder.

**Lesson:** When a format is supported by one surface through a bundled
decoder, check every other surface's decoder path and feature gates before
assuming the format "works". A cargo feature that defaults off is invisible in
release builds even when CI lints it.
