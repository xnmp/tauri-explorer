# #681: format-preserving crop codecs

This records the native codec, owned-save and application verification. Linux
native UI and filesystem saves are verified; Windows/macOS codec CI and native
platform UI qualification are recorded separately. Per-buffer limits are not
a guarantee of bounded aggregate codec process memory.

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

## Source capture and save checkpoint

Crop from immutable captured bytes rather than the preview's mutable asset URL.
Bound the capture separately from encoded output (32 MiB input, 200 MiB encoded
output), and compare retained-handle identity, size, modification time,
permissions and SHA-256 before saving. Filename extensions must agree with the
encoded format. A file replaced by identical bytes is still a different source.

Stage encoded content before displacing an original. Copy publication must use
the existing atomic no-overwrite rename, including a collision racing the
initial name choice. Failed rollback that retains the original while a foreign
writer occupies its name is `MutationUncertain`, so native history and affected
directory refresh cannot incorrectly report an unchanged filesystem.

Durable copy replacement expressly requires independent source and destination
authority. Using the original as its own source violates admission and breaks
the source guard after displacement. Keep a separate generated `StagedEntry`
and its parent alive through the entire forward transaction. Completed Undo and
Redo use retained journal artifacts and must work after staging cleanup. Check
the original digest again on retained `ORIGINAL`, after displacement and before
publication; restoring a timestamp must not conceal an intervening content edit.

The editor opening owns its captured source and blob URL. A late capture cannot
reopen a closed editor; an accepted save cannot be redirected by selection,
reopening or duplicate activation. Publication survives editor destruction and
uses the existing pane refresh policy. Explicit local preview revision and
thumbnail invalidation cover replacements retaining coarse mtime/byte size.

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

The AVIF codec checkpoint passed 36 tests, including 13 AVIF cases.
The independent CLI decoder validates generated fixtures; before-fix runs
reproduce the four metadata/sequence failures,16-bit base-layer truncation and
lost gain map. That checkpoint established codec behavior only. Later SVG, owned-save and
application verification are recorded below; platform CI remains distinct.


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
or native file publication; those require the separate native application suite.

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
checkpoint does not qualify arbitrary animated SVGs or platform UI.


## Application verification

A connected SVG image can report its CSS layout width as `naturalWidth` in
WebKit. Decode an unattached image from the immutable capture to establish
the source viewport before fitting the canvas. Read ICNS preview data as the
validated largest PNG representation: browsers do not decode a raw ICNS
container. Use BMP V4 alpha masks for alpha fixtures; the high byte of BI_RGB
pixels is reserved and engines legitimately interpret ambiguous fixtures
differently.

Numeric crop inputs must retain intermediate digits until blur or Enter.
Clamping each keystroke makes a valid coordinate such as 480 impossible to type
when the first digit lies outside the current rectangle. Accepted saves retain
modal ownership through Escape until the operation settles; a component-local
close guard alone does not protect the shared modal stack.

Physical viewport bounds and app zoom use different coordinate spaces. The
crop overlay cancels root zoom, restores the requested zoom on its card, and
provides scrolling for a resized viewport. Crop controls must use existing
theme tokens; undefined background variables silently erase transparency
checkerboards and handle borders.

JPEG geometry checks must find real interior quadrant transitions and fail
when they are absent. A first-dark-pixel check against a JPEG without a black
center is vacuous. Independent shifted crops demonstrate that the transition
check catches four-pixel offsets even when interior color samples still match.

The actual save pipeline is also tested with animated GIF, WebP, APNG and
AVIF files. Decode saved filesystem bytes and compare composited cropped frames,
frame count, duration and looping; a codec-only byte test or static screenshot
does not establish animated publication.

PNG/WebP EXIF and AVIF aperture/rotation/mirroring do not have consistent
webview support. A correctly oriented native save can therefore crop a
different region than the editor shows. Normalize captured preview bytes
through the same normalized pixel decoder used for saving. PNG/WebP previews
retain animation; AVIF crop previews use a first-frame PNG because hosted
Ubuntu WebKit cannot decode AVIF at all. Label that first-frame display and
keep the original path, revision, format and whole sequence for publication.
Retain base ICC in PNG iCCP without competing cICP (PNG 3 precedence); otherwise
carry RGB/full-range cICP and content-light metadata. Scale 10/12-bit samples to
the PNG 16-bit range in network byte order. The independent system/official avifdec CLI
verifies saved AVIF pixels with the same PNG pipeline as the committed references.
Bound the resulting preview before base64 IPC; that output bound does not establish
aggregate codec memory or latency. Compare native UI saves against independent
untagged pixel references, rather than drawing the same metadata-bearing input
through the same browser and calling that an oracle.

At root zoom 150%, WebKit evaluates the tested container width query against
the zoomed width while Chromium uses CSS layout width. Shallow top/bottom
preview docks need a header allocation that works without that query. Share
the row between filename and Crop, omitting the auxiliary image badge; a new
action row consumes the minimum dock's usable preview height. Check filename
width, metadata width and content height in both engines.

AOM's build target exports only install-interface headers. When libavif uses
the bundled target, explicitly propagate its pinned source headers with an
interface build include. Host-installed AOM headers can mask the omission,
so inspect the actual compiler dependency file and qualify clean hosted builds.

Native numeric-input probes need explicit key down/up pairs for every digit.
In the tested WebKitWebDriver path, `browser.keys("11")` sends only one `1`;
the app then correctly clamps that incomplete value on blur. Trusted DOM event
receipts distinguish this harness failure from premature input clamping. Assert
the typed value before Tab and use real per-character actions; assigning a DOM
value and dispatching input does not exercise the native change/blur contract.


Hosted Windows successfully cropped and displayed oriented AVIF at 6 × 8 but
its native AVIF decode differed by four channel values from a PNG reference.
Do not relax the exact assertion: decode actual saved AVIF independently to
PNG before comparing those pixels. Linux loading failures and Windows oracle
differences are separate findings. The PNG display fallback does not replace
real codec/filesystem tests or prove gain-map HDR reconstruction in webviews.
