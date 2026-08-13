# 664 — Video preview resolution

`PreviewPane.svelte` and `ThumbnailImage.svelte` share the ffmpeg-backed
`getVideoThumbnailData` API but serve different surfaces. The preview pane's
still frame is also used by fullscreen, so it must request its explicit 1024px
source. Tile views must continue to pass their configured generation sizes so
their smaller cache entries remain independent.

Browser coverage can observe this IPC seam by letting the video-thumbnail mock
record its optional size argument. A regression test should exercise both the
Tiles view and preview selection; otherwise a test that only asserts the image
renders cannot distinguish a 128px fallback from a preview-sized frame.
