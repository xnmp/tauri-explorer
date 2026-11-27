# Fullscreen video click paused nothing and exited fullscreen

#1058 made a click on the `<video>` surface toggle fullscreen, in both
directions. In fullscreen that meant a click minimized the preview, where every
video player pauses/plays instead (Windows report, v0.33.3).

`videoClickAction(control, fullscreen)` now returns `toggle-play` for a surface
click while fullscreen and `fullscreen` when docked. Exit stays on F, Escape and
the fullscreen button. Overlay and button clicks still have no action.
