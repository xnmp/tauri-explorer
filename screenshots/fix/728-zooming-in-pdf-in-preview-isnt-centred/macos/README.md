# Partial production macOS PDF evidence

These eleven unedited full-display captures come from hosted run37044383860,
production WKWebView on disposable macOS arm64, 1024×768 points/pixels, light
theme and100% app zoom. Source/binary/image hashes and native pixel measurements
are in `docs/reviews/pdf-preview-2026-10-02/macos/`.

- `01-fit-page-1.png`: centered whole first page with both corners.
- `02-centered-130-percent.png`: native130% document zoom stays centered.
- `03-page-2.png` / `03-page-3.png`: landscape/purple and portrait/orange pages.
- `04-returned-page-2.png` / `04-returned-page-1.png`: actual return navigation.
- `05-before-pan-400-percent.png` / `06-after-native-pan.png`: red landmark
  moves40points left and30up after native dragging; still images alone do not
  establish pointer tracking.
- `07-reset-fit.png`: reset restores centered whole-page fit.
- `08-fullscreen.png` / `09-exit-fullscreen.png`: actual fullscreen and return.

The overall run failed afterward: responsive navigation hides its Up button in
the narrower listing pane, invalidating the test's app-zoom measurement anchor.
The harness now measures the fixture's fixed-size New Tab control instead,
retaining its zoom ratios and all later outcome assertions.

This evidence does not qualify150% app zoom, resized dock layouts, corrupt-file
errors, image replacement or final unchanged source bytes on macOS. The last
source-preservation assertion was not reached; the report records the initial
fixture hash only. Supported-platform acceptance remains pending.
