# Native crop fixtures

These small input files are codec fixtures, not application screenshots.

- `image-crop-animation.gif` and `.webp`: independently generated with Pillow;
  three 8×6 frames, unequal frame durations and finite looping. Tests compare
  every cropped composited RGBA pixel and frame timing against decoded input.
- `image-crop-interlaced.gif`: independently encoded interlaced GIF input.
- `image-crop-interlaced.png`: independently encoded Adam7 PNG using pypng.
- `image-crop-animation.png` and `image-crop-animation-poster.png`: Pillow APNG
  inputs exercising blend/disposal, unequal durations, finite looping, and a
  separate default image in the latter file.
- `image-crop-interlaced-animation.png`: independently Adam7-encoded pypng
  datastreams assembled into an APNG with an 8×6 first frame and a 3×3 second
  frame at (2,1). The first frame is RGBA (200,20,30,255); the second frame's
  pixel (x,y) is (10+40x,100+30y,180,255). FFmpeg with passthrough frame timing
  independently verified those nine partial-frame pixels. Pillow's APNG reader
  could not decode this interlaced partial-frame case in the fixture environment.
- `image-crop-subsampled.jp2`: Pillow/OpenJPEG lossless RGB JPEG2000 data, with
  reference-grid/tile dimensions scaled from 16 to 32 and uniform component
  sampling changed from 1 to 2. The JP2 image header matches the 32×32 reference
  grid. The locked ICNS decoder returns a complete 16×16 representation;
  OpenJPEG also accepts and decodes its header and codestream.

Additional tests construct native PNG/APNG and ICNS inputs with explicit
16-bit samples, orientation tags, valid/invalid color metadata, distinct legacy
representations, and deliberately invalid container lengths.

## AVIF inputs

`python3 generate-image-crop-avif.py` regenerates these inputs;
`generate-image-crop-gain-map.c` generates the gain-map input.

Generated independently with the installed `avifenc`/`avifdec`1.4.2 tools,
using AOM for encoding and dav1d for independent decoding, rather than this
crop bridge. All small rasters are synthetic and contain recognizable coordinate
colors. `image-crop-srgb.icc` is a valid sRGB profile generated with Pillow/ImageCms.

- `image-crop-static.avif`:16×12 lossless RGBA8 with that ICC profile.
- `image-crop-hdr.avif`:12-bit PQ/BT2020, alpha and CLLI(3000,1000).
  Fixture creation quantizes the16-bit PNG input to12-bit; crop tests compare
  against the actual12-bit AVIF, not the original16-bit PNG.
- `image-crop-sixteen-bit.avif`: lossless8+8 sample-transform extension.
  Tests check every selected16-bit sample against the independent input formula.
- `image-crop-animation.avif`: three lossless16×12 RGBA frames lasting7/12/15
  ticks at100 ticks/second, with two repetitions after the first play.
- `image-crop-oriented.avif`: CLAP(2,1,12,8), counterclockwise IROT1 and IMIR1.
  `image-crop-oriented-reference.png` is the independently transformed output
  from the installed `avifdec`; crop tests compare every normalized source pixel.
- `image-crop-aspect.avif`: IROT1 with pixel aspect ratio2:1. Once rotation is
  baked into the cropped pixels the output aspect ratio must be1:2.
- `image-crop-unknown-loops.avif`: derived from the animation by renaming only
  its parsed `moov/trak/edts` containers to valid `free` boxes. Sizes/offsets and
  compressed samples stay intact. The independent decoder confirms an unknown
  repeat count and all three frame timings.
- `image-crop-one-frame-sequence.avif`: restricts both animation sample tables
  to the first frame, sets movie/media/edit durations to21/7/7 ticks, and pads
  shortened tables with valid sibling `free` boxes so chunk offsets stay intact.
  The independent decoder confirms one frame, duration7/100 and repeat count2.
- `image-crop-gain-map.avif`: generated using a separate C program against the
  installed system libavif, without linking the crop bridge. Synthetic16×12
  RGBA base plus8×6 gain map, HDR headroom0→2, distinct alternate-image PQ/12-bit
  metadata and CLLI(6000,1400). Tests compare all gain parameters and reconstructed
  linear half-float RGBA at headrooms0,1,2, including fractional crop origins
  relative to the lower-resolution gain map.

Additional gain-map fixtures cover full CLAP/IROT/IMIR with an equal-size gain
map, colorful YUV420/BT601 with distinct per-channel gamma, and alternate ICC
retention. The system writer refuses equal-size CLAP gain maps, so the independent
generator reserves an opaque32-byte `crop` property before IROT/IMIR for both
items, promotes only that parsed `ipco` box type to `clap`, and marks its parsed
`ipma` references essential. No box size, offset or compressed sample changes.
The unmodified system decoder accepts the resulting source; a separate review
independently derives all48 selected coded coordinates. ICC tests establish
retention/base-pixel preservation; the upstream HDR utility rejects ICC conversion.

These are native codec inputs, not application screenshots or save-flow proof.
