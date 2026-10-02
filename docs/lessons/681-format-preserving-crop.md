# #681: format-preserving crop codecs

This records the native codec checkpoint. Crop controls, owned save operations,
SVG and AVIF integration are still pending; this does not establish acceptance
of the complete feature.

PNG color interpretation is part of the image. Preserve accepted gamma,
chromaticity, ICC and HDR metadata when retaining its sample values. The PNG
decoder ignores ancillary chunks with invalid CRCs and data after IEND; copying
raw chunks through `write_chunk` can give ignored metadata a valid CRC and change
the saved appearance. Serialize the decoder's accepted HDR fields instead.
Content-light metadata can legally follow image data, so scan through IEND
without decompressing pixels before preparing the output header.

Decoded interlaced samples must be emitted as ordinary scanlines unless an
encoder actually re-interlaces them. In png 0.18.1, Adam7 APNG subframes use the
canvas-width stride in the destination buffer, while noninterlaced subframes use
their own width. A smaller Adam7 second frame exposes stale-row reads that a
full-canvas or static fixture misses. Crop raw animation regions and retain
their blend/disposal operations, rational frame delays, loop counts, separate
poster images and 16-bit samples. An outside-crop frame still contributes time.

ICNS element lengths must be checked against actual input before rust-icns
allocates their declared buffers. Bound embedded PNG dimensions and JPEG2000
reference grids, component sampling and tile counts before decoding. Uniform
JPEG2000 component sampling changes the decoded dimensions; reference-grid
bounds and representation-dimension validation serve different purposes.

The owner selected fixed ICNS canvases with transparent padding. Bare `ICON`
has no transparency, so promote it to the same-size `ICN#` representation.
Combined monochrome-and-alpha representations are also classified as masks by
rust-icns and omitted from its `available_icons`. Include them explicitly, prefer
an existing masked representation over bare `ICON`, and retain same-size colored
representations as the preview preference. Decode legacy samples into RGBA
before constructing an image buffer. Encode original combined masks first and
deduplicate OSType entries so palette-generated companion masks do not overwrite
independently different monochrome pixels.

Regression fixtures must distinguish these cases: independent Adam7 partial
frames; accepted and ignored HDR chunks; bare and combined legacy icons; black
monochrome pixels sharing an alpha mask with white Palette4/Palette8 pixels;
and a JPEG2000 representation with uniform component subsampling. Decoder output
pixels and metadata are the contracts, rather than encoder implementation steps.


## AVIF codec checkpoint

Bundle checksummed libavif1.4.2/AOM3.14.1 source archives rather than depend on
an unpinned build-time download or a host-only native package. Build the public
`avif_static` merged archive explicitly: upstream's internal `avif` target emits
`avif_internal`, and an install target alone does not build an excluded archive.

Recognize animated `avis` with libavif's file-type probe; image's format guesser
only recognized the static fixture. Enable gain-map and sample-transform decode
content before parsing, or valid16-bit inputs silently expose an8-bit base layer.
Preserve CLLI and swap PASP axes after an odd rotation. Retain a one-frame track
using its actual sequence flag, and preserve absent edit lists for unspecified
looping. The pinned writer needs small checked corrections for those two cases.

Crop lower-resolution gain maps on the expanded original base grid before
orientation/crop, following libavif's own HDR reconstruction scaler. Re-encode
losslessly and retain all gain/alternate metadata, including `altYUVRange` which
this upstream image-copy implementation omits. Verify actual half-float HDR
reconstruction at several headrooms, not just a retained gain-map marker.

Current native crop regression set passes36 tests, including13 AVIF cases.
The independent CLI decoder validates generated fixtures; before-fix runs
reproduce the four metadata/sequence failures,16-bit base-layer truncation and
lost gain map. These are codec checks only. SVG, owned saving, UI, screenshots,
resource admission and Windows/macOS AVIF qualification remain unfinished.
