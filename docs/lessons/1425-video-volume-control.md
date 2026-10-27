# Video volume control renders its own changes immediately

The speaker button replaced the "Sound" text button and always-visible slider
(#1425). Its slider is collapsed (zero width, `visibility: hidden`) until the
volume control is hovered or receives keyboard focus, so browser and native
specs must reveal it (hover `.volume`, or `revealVolume()` in
`e2e-tauri/video-observations.ts`) before interacting with or measuring it.

`volumechange` is queued and, under load, can trail several inputs. Rendering
only from that event left the slider at 0 after a quick mute/unmute, and
stepping from the stale rendered state repeated the first toggle. Derive every
change from the live `<video>` element and sync the rendered state right after
writing it; `volumechange` remains the path for external changes.
