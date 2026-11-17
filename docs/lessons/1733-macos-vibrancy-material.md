# macOS vibrancy: material, every window, and a theme tint (#1733)

## Material

The vibrant window uses `NSVisualEffectMaterial.sidebar`
(`WindowEffect::Sidebar` / JS `Effect.Sidebar`), state Active.
`UnderWindowBackground`, used before, looked opaque in dark mode: the window
read as a flat grey panel and the desktop never showed through. Sidebar is the
material Finder's own sidebar uses and stays visibly translucent in both
appearances.

## Every window, not just the first

Only the Rust-built main window used to get the material. Fresh Ctrl+N
windows and parked warm windows are created from JS through
`state/window-appearance.ts`, which on macOS asked for an opaque window with
the persisted background colour. The page CSS still made the body transparent
(it keys off the setting, not the window), so a second window showed that
opaque colour with no material at all.

`domain/macos-vibrancy.ts` now decides, for both JS paths, the same thing
`lib.rs` decides for the main window from `settings.json`:

| Window Vibrancy | Native Blur | Window                         |
| --------------- | ----------- | ------------------------------ |
| off             | any         | unchanged (opaque)             |
| on              | off         | transparent, no material       |
| on              | on/missing  | transparent + Sidebar, Active  |

A transparent window must not get the persisted opaque `backgroundColor`;
it would hide the material. Nothing changes on Linux or Windows.

The Rust main window is built before any webview exists, so it cannot call
the TS module. `lib.rs` declares `MACOS_VIBRANCY_MATERIAL`, and
`tests/domain/macos-vibrancy.test.ts` reads it and fails if the two names
drift. Change both together.

## Theme tint over the material

The material is a neutral grey. Without help every theme collapses to the same
grey window. `+page.svelte` sets `[data-macos-material]` (macOS, vibrancy and
Native Blur on) and paints the theme base over the window body:

- `light-dark(color-mix(base 15%), color-mix(base 55%))`, following the
  theme's `color-scheme`. Dark themes need far more: a 15% dark wash over the
  grey still reads as grey, while 55% on a light theme turns the window opaque.
- A theme can supply its own `--vibrancy-tint`. Tahoe's lavender wash dropped
  from 0.35 to 0.12, in line with the 15% light default; 0.35 smothered the
  material.
- A layout that paints the window body itself sets `--layout-app-surface`,
  which wins over the tint.
- Light themes (`light.css`, `solarized-light.css`) use an island card alpha of
  0.3, so the islands stay as translucent as the tinted body around them.

Windows Mica/Acrylic keeps its own strength tint (`window-backdrop.ts`) and
does not get the new default. It still reads a theme's `--vibrancy-tint`, so
Tahoe's lower value applies there too.

`light-dark()` in bundled CSS is compiled by Lightning CSS into
`--lightningcss-light/dark` variables that only bundled themes define. Until
the build excludes that feature, a runtime user theme gets no tint (the
declaration computes to transparent, the pre-#1733 look) rather than a wrong
one.

## Capture gotcha

A screenshot of a covered window does not show the material. The
behind-window blur samples what is actually on screen behind the window, so a
window-only capture (`screencapture -l`, or any capture taken while another
window covers it) shows the material wrong or not at all. Judge the material
only from a capture of the frontmost, uncovered window over a recognisable
wallpaper.

Browser E2E cannot show the material at all. `e2e/macos-vibrancy.spec.ts`
pins `navigator.platform` to `MacIntel`, simulates the material with an html
background, and asserts the tint through computed styles. Linux CI cannot
verify the real NSVisualEffectView.
