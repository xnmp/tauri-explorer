# #1530 — CSS `filter` on `<img>` icons wrecks Tiles scrolling in WebKitGTK

**Symptom.** A folder of plugin-iconed files (127 Brood War replays) lagged
when scrolling in Tiles; better with the plugin disabled.

**Cause.** Every file icon carries `.icon-cat { filter: drop-shadow(...) }`.
On the plugin icon's `<img>` element, WebKitGTK re-rasterizes the filter for
every visible tile on every scroll frame. Measured in the real release build
(1,596 tiles, in-page scroll of 30 px per frame, median frame time): plugin
icon with the filter 120-190 ms; same icon with `filter: none` 17-19 ms;
built-in inline-SVG icons (which keep the filter) 26-29 ms, p95 ~105 ms.

**What did not matter.** The SVG's content (a single `<rect>` cost the same as
the detailed artwork) and its representation: rasterizing each icon once to a
shared bitmap blob URL measured the same as the SVG data URI. Headless
Playwright WebKit showed only a 20-30% difference, so it could not rank fixes;
measure CSS-paint costs in the real WebKitGTK build.

**How it was measured.** Temporary probe in the release build: a key handler
scrolled the active pane's scroller each `requestAnimationFrame` for 3.5 s and
logged interval percentiles through `log_startup_progress` (marks are
`[a-z0-9-]`); the window ran on a headless Hyprland output and keys were sent
with `hl.dsp.send_shortcut`. Plugin CSS variants (a plugin's own stylesheet can
override host classes) isolated the filter without rebuilding the app.

**Guard.** `e2e/plugin-file-icons-columns.spec.ts` asserts the plugin icon's
computed `filter` is `none` in List and Tiles. Built-in icons' shadow cost is
tracked separately.
