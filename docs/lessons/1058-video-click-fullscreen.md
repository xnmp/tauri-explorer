# Video preview click toggles fullscreen

Picture preview enters fullscreen on a click at fit zoom, but the video surface
had no pointer handler, so a click did nothing and only the transport button,
F, and double-click on the pane (which excludes video) reached fullscreen.

The overlays and the Open-externally button sit beside the `<video>` inside the
stage, so the stage click classifies its target: only the video element is the
surface. Playback stays on Space and the Play button, because picture preview's
click only toggles fullscreen and does not act on the content.
