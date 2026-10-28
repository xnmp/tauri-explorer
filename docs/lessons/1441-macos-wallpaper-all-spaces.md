# #1441 — macOS "Set as Wallpaper" on every display and Space

## Symptom
On macOS, Set as Wallpaper changed only the current Space and only one
display. `tell every desktop` in System Events covers only the desktops of
the active Space. With "Displays have separate Spaces", each display's
desktop belongs to its own Space.

## Findings
- **There is no public API for other Spaces.**
  `NSWorkspace.setDesktopImageURL(_:for:options:)` takes an `NSScreen`, so
  calling it once per `NSScreen.screens` covers every display, but only on the
  current Space. Both `desktoppr` (scriptingosx) and sindresorhus
  `macos-wallpaper` stop there; sindresorhus documents the restriction to the
  active Space.
- **On macOS 14 (Sonoma) and later, the choice for each Space lives in a
  private store:**
  `~/Library/Application Support/com.apple.wallpaper/Store/Index.plist`
  (binary plist). Its top-level sections:
  - `AllSpacesAndDisplays` is the "Show on all Spaces" entry.
  - `Displays.<id>` holds per-display entries.
  - `Spaces.<id>` holds per-Space entries, with `Default` and
    `Displays.<id>` beneath.
  - `SystemDefault` is the factory fallback.

  Each entry contains `Desktop.Content.Choices[]`, and a still-image choice
  in it has three keys:
  - `Provider = com.apple.wallpaper.choice.image`
  - `Files = [{ relative = "file:///…percent-encoded…" }]`
  - `Configuration = <data>`, a nested binary plist that holds placement and
    colour.

  `Idle` is the screen saver. `WallpaperAgent` loads the store at start, so a
  restart is needed after editing it.
- **NSWorkspace splits the store into per-Space entries.** A set made through
  NSWorkspace (or System Events) turns "Show on all Spaces" OFF, and later
  sets reach only the current Space. This explains why the bug appears after
  the first use (Apple forums threads 814926 and 784381; pnitijarasrat/dotfile#102).
- **macOS 13 and earlier** keep this in the Dock's `desktoppicture.db`
  (SQLite). Its `data` table holds the values of every preference, not just
  image paths. The widely copied `UPDATE data SET value=…` therefore also
  overwrites unrelated preferences. We deliberately do not edit it. On 13 and
  earlier, the toast says that only the current Space changed.

## Design
- `wallpaper/macos.rs` handles the orchestration.
  - It calls NSWorkspace once per screen, through JXA with the path passed
    as argv.
  - On 14 and later, it polls the store (up to 3 s) until macOS has persisted
    its own entry for the new image.
  - That OS-written `Desktop.Content` is then copied into every
    `Desktop.Content` under `AllSpacesAndDisplays`, `Displays` and `Spaces`.
  - It writes atomically (temp file, then rename) and runs
    `killall WallpaperAgent`.
- **We never fabricate a `Configuration` blob.** If the OS entry never
  appears, we copy another still-image choice and replace its `Files`.
- `wallpaper/macos_store.rs` is the pure transform, and it fails safe. A store
  that is unparseable, lacks `AllSpacesAndDisplays`, has no recognised
  entries, or has no still-image template is never written. The walk is
  depth-limited. `SystemDefault`, `Idle`, `Type`, dates and unknown keys are
  left untouched.
- The command now returns `WallpaperOutcome { notice }`. A notice means a
  partial result: some displays, only the current Space, or a store write or
  restart failure. The frontend shows it as an info toast. Linux and Windows
  always return `notice: null`.

## Unverified without a Mac
- The exact nesting under `Spaces`. The walker finds any dictionary shaped
  like `Desktop.Content.Choices` up to depth 5, so variants of the nesting
  still match.
- Whether WallpaperAgent flushes its in-memory state over the store on
  SIGTERM. The dotfile#102 tool did the same thing (it restarted with
  `launchctl kickstart -k`) and it worked on 14.1.
- Behaviour on macOS 26 (Tahoe).

## Checking it
Unit tests run on every host: `cargo test --lib wallpaper`.

To type-check from Linux, run the macOS cross-check with the C build scripts
stubbed:

```
CC=true AR=true TURBOJPEG_SOURCE=explicit TURBOJPEG_LIB_DIR=<empty> \
TURBOJPEG_INCLUDE_DIR=<empty> cargo clippy --target aarch64-apple-darwin --all-targets -- -D warnings
```

The vendored `explorer-avif` cmake build script also fails under `CC=true`;
stub it locally and never commit the stub.
