# 1756: custom window controls beside macOS traffic lights

macOS windows are always natively decorated (`lib.rs`: `decorations(cfg!(target_os = "macos"))`, overlay title bar),
so the custom min/max/close set duplicated the traffic lights whenever `showWindowControls` (default on) was set.

Rule: never read `settingsStore.showWindowControls` for layout; use
`effectiveWindowControls(setting, isMac)` from `domain/titlebar.ts`. It feeds `showTitleBar` and `showTabStrip`
too, since controls that never render must not hold the lone-tab row open. The settings row is hidden on macOS
(`settingsSectionRows` also drops it from search). The `view.toggleWindowControls` command remains but has no visible effect on macOS.
