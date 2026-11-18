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
- **A window's material is fixed at creation, and its creator says which.**
  - Transparency cannot be toggled on a live window. The old code restyled
    the page whenever the setting changed, which put a transparent page on an
    opaque window (or the reverse) until a restart.
  - Inferring the material from settings is not enough either: a reload or a
    renderer recovery re-reads settings that changed since, a corrupt
    settings.json builds an opaque window while the localStorage cache says
    on, and a fresh child can read settings.json before the toggle's write
    lands. So the creator publishes it. The Rust main window's own
    initialization script sets `__WINDOW_MATERIAL__`. JS windows carry
    `material=` in their URL (`withWindowMaterial`), which recovery keeps,
    since it drops only `warm`. `builtWindowMaterial` reads either.
  - Only the browser build infers. `state/window-translucency.svelte.ts`
    follows the setting until settings load, then settles.
  - Parked warm windows are labelled `explorer-warm-<material|none>-<uuid>`.
    A claim that finds the wrong material retires that window and opens fresh.
    Recycling on the toggle would miss the palette toggle and other windows.
- **The pre-paint background is opaque by design.** `app.html` paints the
  cached `explorer-bg` inline, and inline beats `html { background:
  transparent }`, so it covered the material for a whole session after the
  setting was turned on. It is now applied only in windows whose creator
  named no material, and `applyTheme` saves it only from opaque windows, so
  it stays the opaque theme colour.
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
- **Windows opacity migration preserves the island alpha, not the whole look.**
  Backdrop Opacity was the islands' fill alpha. `opacityForIslandAlpha` finds
  the slider percent whose dark island alpha matches it, so the default 65
  becomes 81. The total coverage still shifts (light islands come out nearly
  opaque at 81), and Mica users on 22H2+ now get acrylic, by design: one
  setting, each platform's best material. The slider was macOS-only before,
  so a Windows blob's `translucencyOpacity` is a default from some
  whole-object save, and the carry-over replaces it.
- **The slider now reaches every layout.** The window tint of layouts without
  islands is `--material-window-coverage*`. At the default it is the old
  fixed 15% / 55%.
- **Reduced transparency covers every layout.** Floating Islands solidifies
  its islands. `+page.svelte` paints `.explorer` solid under
  `prefers-reduced-transparency`, which covers the default layout and soft
  cards.
- **User layouts lose the old attributes.** `data-macos-material`,
  `data-win-backdrop` and `data-transparent-window` were part of the
  documented layout contract and have no alias. `docs/layout-themes.md`
  says which attributes replaced them.
