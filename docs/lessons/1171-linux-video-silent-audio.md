# #1171 — Linux videos play without sound

WebKitGTK builds each `<video>` pipeline from the installed GStreamer plugins. When the
picture's decoder exists but the audio codec's does not — the common case is an
H.264/AAC MP4 with a hardware or openh264 H.264 decoder but no `gst-libav` — playbin
simply leaves the audio stream unlinked. There is no media error, `readyState` reaches
`HAVE_ENOUGH_DATA`, the volume/mute controls change `video.volume`, and nothing is heard.
The only page-visible signal is `video.audioTracks.length === 0`. Reproduced with the
real binary on a private PipeWire null sink: VP8+AAC Matroska recorded silence while
the same file with Opus audio was audible; a WebM/Opus file through the loopback media
server was audible, so the server and component were not at fault.

Fix: on Linux only, once the video can play with no native audio track, ask the backend
for companion audio. `media_preview/audio.rs` probes with ffmpeg (`Stream #…: Audio:`),
decodes the first audio stream to Opus/WebM (FLAC when ffmpeg lacks libopus; both use
stock GStreamer base/good decoders) in a private cache directory, and the media server
publishes it under its own capability. `MediaFile` deletes a derived file when its last
user drops it, and release kills an in-flight decode. `state/video-companion-audio.ts`
makes a hidden `<audio>` follow the video's play/pause/seek/rate/volume/mute; a native
`addtrack` drops the companion so both are never heard.

- Detection needs `canplay`/`playing`, not `loadedmetadata`: wait until the pipeline has
  prerolled before trusting an empty track list.
- Chromium/WebView2 has no `audioTracks`, and WKWebView decodes AAC natively; the check
  is gated to Linux so Windows/macOS playback is unchanged.
- Verify audibility, not element state: record a PipeWire null-sink monitor
  (`pipewire` + `wireplumber` + `pipewire-pulse` under `dbus-run-session`, `pactl
  load-module module-null-sink`, `parecord -d <sink>.monitor`) and compare RMS. Element
  timing alone passed while the speakers were silent.
- Checking for decoders: `gst-inspect-1.0 | grep -i aac`. Packaging is not a fix by itself;
  AppImage and source builds use whatever plugins the host has.
