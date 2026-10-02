# Bundled AVIF crop codec

This small Rust/C interface builds pinned libavif and AOM from local source
archives. A normal Cargo build needs CMake and a C/C++ compiler, and makes no
network requests. Generic portable C implementations avoid an assembler
requirement. The image-crop workflow qualifies codecs and filesystem saves on Linux,
Windows and macOS; native UI qualification is tracked separately in the PR.

## Provenance

- [libavif1.4.2](https://github.com/AOMediaCodec/libavif/releases/tag/v1.4.2),
  commit `c5240fc79fe5c2407e10afd35f5505ef6333ea49`;
  archive SHA256 `2b645287340ba5a631d268b551dc2d72bd73ac33335962dd36dcdb6d8366921d`.
- [AOM3.14.1](https://aomedia.googlesource.com/aom/+/refs/tags/v3.14.1),
  official Gitiles source archive;
  SHA256 `a1145ee86b9659734681e10bce91ebace21a93e443069c91eb28360d38a818fc`.

Original compressed archives remain unchanged. CMake verifies their checksums
before extraction. Original licenses and AOM's patent grant are under `upstream/`.
The public libavif static archive merges the local AOM dependency.

## Preservation and ownership

The bridge parses AVIF/AVIS, decodes every frame, applies clean aperture,
counterclockwise rotation and mirroring, selects full-resolution pixels, then
encodes losslessly with identity/full-range YUV444. This preserves decoded RGB
samples rather than introducing another chroma or quantization loss. JPEG-like
source encoding losses cannot be undone. ICC/CICP, alpha, CLLI, pixel aspect ratio,
frame durations, timescale and repeat policy survive. Sixteen-bit sample transforms
are decoded in full and re-encoded using the lossless8+8-bit extension.

Gain maps expand to the original base pixel grid using libavif's own scaler
before cropping and applying the base orientation. The cropped gain map uses
that same pixel grid, retains gain/alternate-image metadata and is encoded
losslessly. Native tests compare reconstructed half-float HDR pixels at several
headrooms. Old EXIF/XMP payloads are discarded after orientation is baked into
pixels so stale orientation/dimensions cannot be reapplied.

`patch-sequences.cmake` applies four narrowly checked substitutions to the pinned
writer: honor the explicit SINGLE flag rather than frame count when deciding
whether to emit a sequence; accept an unknown repeat count; use one pass for its
movie duration; and omit its edit list. This preserves an absent repeat policy
and one-frame sequences without adding frames or assuming finite/infinite looping.
Each replacement accepts only the exact original or exact patched fragment.
The pinned encoder currently refuses sample transforms combined with gain maps,
and gain maps in multi-frame sequences. Those inputs fail explicitly rather than
flattening or dropping their auxiliary content. Its HDR reconstruction utility
also refuses ICC color conversion; alternate ICC retention is tested separately.

Native pixel/profile allocations have one Rust RAII owner and are released on
all paths. Base ICC profiles are copied into a separately bounded owned buffer
(at most32MiB) before decoder retirement. The image layer uses that profile for
browser-compatible PNG first-frame previews without changing AVIF save inputs.
Input/output files are capped at200MiB, dimensions at16384 per side, a decoded
canvas at33554432 pixels, frames at1024 and aggregate base decode work at268435456
pixels. These are individual validation/work bounds, **not a process-memory
ceiling**: the output-size check runs after native encoding, and codecs retain
compressed frames. The file layer owns renderer/session admission, source revalidation, staged
publication and recovery. Codec tests alone do not qualify that lifecycle.

## Verification

`cargo test --locked --manifest-path src-tauri/Cargo.toml image_crop::tests::avif --lib --offline`

Fixture provenance and independent decoder validation are described in
`src-tauri/test_support/fixtures/README-image-crop.md`. These codec tests do not
prove filesystem saves, native preview behavior or cross-platform portability.
