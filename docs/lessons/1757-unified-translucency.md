# #1757: one Translucency setting across platforms

## What changed

macOS had Window Vibrancy, Native Blur and Translucency Opacity. Windows had
a Window Backdrop select (Off / Mica / Acrylic) and Backdrop Opacity. Each
platform had its own CSS model: a coverage contract on macOS and a single
alpha on Windows. Now there is one `translucency` setting and the one
`translucencyOpacity` slider, and one coverage contract keyed on
`[data-material]`.

## Gotchas

- **The native side picks the material.** Only Rust knows the Windows build.
  Acrylic below build 22523 is the legacy accent-policy blur, which lags on
  drag and resize, so those builds get Mica. Windows 10 gets nothing.
  - `src-tauri/src/translucency.rs` publishes the choice to every page as
    `window.__TRANSLUCENCY_MATERIAL__`, through a plugin `js_init_script`.
  - A plain `initialization_script` would reach only the main window.
  - The browser build has no published value, so `platformMaterial` falls
    back by platform. That keeps simulated macOS and Windows specs meaningful.
- **A window's material is fixed at creation.**
  - Transparency cannot be toggled on a live window. The old code restyled
    the page whenever the setting changed, which put a transparent page on an
    opaque window (or the reverse) until a restart.
  - `state/window-translucency.svelte.ts` follows the setting only until the
    window's settings load, then settles. Those are the settings the native
    window was built from: Rust reads the same settings.json, and JS-created
    windows read the store when they are created.
  - Residual: a parked warm window keeps the material it was created with.
- **Migrations must read the raw blob.**
  - `normalizeSettingsInput` drops keys the settings no longer define, so a
    derive reading the validated blob could not see `macOsVibrancy` once that
    key was removed. The v2 layout migration depended on it too.
  - `migrateSettings` now takes the raw parsed blob for derives
    (`tests/state/settings-init.test.ts` covers both v2 and v3).
- **Rust must migrate too.** The first launch after an upgrade builds the
  main window before the frontend has migrated settings.json.
  `translucency_enabled` falls back to the legacy keys, by the same rule as
  `legacyTranslucency`.
- **Windows opacity migration preserves the look.** Backdrop Opacity was the
  islands' fill alpha. `opacityForIslandAlpha` finds the slider percent whose
  dark island alpha matches it, so the default 65 becomes 81.
- **The slider now reaches every layout.** The window tint of layouts without
  islands is `--material-window-coverage*`. At the default it is the old
  fixed 15% / 55%.
