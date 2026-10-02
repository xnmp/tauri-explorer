# #681: format-preserving crop codecs

This records the native codec checkpoint. Crop controls, owned save operations, and
preview integration are still pending; this does not establish acceptance
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


## SVG codec checkpoint

Use the captured preview's pixel viewport for relative lengths, CSS sizing and
physical units. A viewBox is a coordinate system, not an intrinsic pixel size.
Static/CSS-animated crops use a clipped vector image containing the original SVG
bytes; this preserves its document root, stylesheet context, definitions and
percentage geometry without rasterizing it.

A WebKit SVG image containing a SMIL-animated SVG image resource freezes after
its initial frames. The same wrapper inserted inline in HTML keeps animating.
DOM screenshots and canvas readbacks reproduce the failure independently;
`SVGImage::isAnimating` checks the outer document's animation state, consistent
with the observed missing subresource dependency. A foreignObject containing
an XHTML image freezes too. Do not add a dummy repaint animation. Ordinary SMIL
therefore stays in the same SVG document inside a captured-size nested viewport.
Refuse SMIL with stylesheets, scripts, foreignObject, document-relative CSS
units (including escaped units), or root viewport/style animations instead of silently changing its appearance. Preserve the absence
of a default namespace on prefixed roots: inheriting the wrapper's SVG namespace
can turn previously ignored foreign nodes into visible graphics. Decode inline
style attribute entities before escaping the serialized value once; copying its
raw escaped text and escaping again turns valid colors into invalid CSS. Resolve
animation targets using unprefixed href before XLink, independent of attribute
order, and decode percent-encoded same-document fragments before matching root IDs.
CSS hex-escape terminators consume CRLF as one newline; numeric XML character
references can preserve that pair even after attribute normalization.

quick-xml tokenization alone does not reject every malformed XML input. Validate
XML qualified names and decoded character references as well as raw characters,
namespace bindings, one root, bounded depth/elements and source encoding. Keep
UTF-16 source bytes intact for the independent-document path; normalize them to
UTF-8 only when writing a same-document result without the source declaration.

Run `node scripts/verify-image-crop-svg.mjs` with the native Cargo build environment.
It exports actual Rust encoder results, then checks natural dimensions, both
crop generations at 1x/2x/4x, and visible SMIL/CSS animation in isolated headless
Chromium and WebKit. Solid geometry requires exact premultiplied pixels. Curves
and filter buffers are re-rasterized by the engine, so those cases require
corresponding source colors within one device pixel and at most 8/255 color
rounding. This is vector rendering qualification, not proof of the Explorer UI
or native file publication. Those remain unfinished.

References: [SVG embedded image rules](https://www.w3.org/TR/SVG/embedded.html#ImageElement),
[XML names and characters](https://www.w3.org/TR/xml/),
[SVG href precedence](https://www.w3.org/TR/SVG/linking.html#XLinkRefAttrs),
[CSS document-relative lengths](https://www.w3.org/TR/css-values-4/),
[WebKit SVGImage animation tracking](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/svg/graphics/SVGImage.cpp).

The current native codec suite passes 44 tests. The independent SVG renderer
checks pass 18 real encoder cases in each engine, including two crop generations,
entity-escaped inline styles, prefixed namespaces and visible animation. Before-
fix runs reproduce malformed XML, namespace inheritance, escaped-style changes,
incorrect animation-target priority and document-relative geometry acceptance.
Styled/document-relative SMIL remains an explicit unsupported context; this
checkpoint does not qualify arbitrary animated SVGs, app saving or platform UI.
