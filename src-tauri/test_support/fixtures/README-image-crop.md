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
