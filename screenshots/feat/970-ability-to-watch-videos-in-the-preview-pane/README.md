# #970 screenshots

Unedited captures of the actual Linux Tauri app (WebKitGTK 2.52.5) on a private display, using synthetic encoded VP8/WebM fixtures. Native source/binary and measured outcomes are recorded in `evidence/970-native-video/README.md`.

- `native-playing-red.png`: playback explicitly started and then paused on the decoded red frame, Details/right dock, 100%, controls and duration visible.
- `native-seek-blue.png`: actual seek to a different decoded blue frame at 0:04 / 0:06.
- `native-fullscreen-blue.png`: fullscreen playback surface and unobscured controls.
- `native-dock-right-150.png`, `native-dock-top-150.png`, `native-dock-bottom-150.png`: operable player controls in every dock at 150% app zoom.
- `native-invalid-container.png`: unsupported-source explanation and external-open option.
- `native-large-decoded-noise.png`, `native-large-distant-seek.png`, `native-large-continuous-playback.png`: real decoded frames from the 1.26 GB fixture at initial playback, distant seek and sustained playback.
- `native-list-seek-blue.png`, `native-tiles-seek-blue.png`: actual native decoded seeking through the other two view modes, right dock, 100%.
- `native-activated-warm-seek-blue.png`: actual decoded frame after a parked native window is activated at the requested directory.

Pixels are supplemented by native timing, file-read, media-state and resource-cleanup assertions. No image editing, simulated player states or host-desktop capture was used.
