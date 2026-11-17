# #1441 — macOS "Set as Wallpaper" on every display and Space

## Symptom
On macOS, Set as Wallpaper changed only the current Space and only one
display. System Events' `tell every desktop` reaches only the desktops of the
active Space, and with "Displays have separate Spaces" each display's desktop
belongs to its own Space.

## Findings
- **No public API reaches other Spaces.**
  `NSWorkspace.setDesktopImageURL(_:for:options:)` takes an `NSScreen`, so
  calling it for each of `NSScreen.screens` covers every display, but only on
  the current Space.
  - `desktoppr` (scriptingosx) and sindresorhus `macos-wallpaper` both use
    only NSWorkspace. Neither changes other Spaces.
  - sindresorhus documents a different gotcha: re-setting the image that is
    already shown is a no-op. It works around this by first setting an empty
    URL and sleeping 0.4 s. Our JXA leaves such screens alone instead and
    reports them as `already` (see Design).
- **The macOS 14+ (Sonoma) store.** Per-Space choices live in
  `~/Library/Application Support/com.apple.wallpaper/Store/Index.plist`, a
  binary plist with these top-level sections:
  - `AllSpacesAndDisplays`: the "Show on all Spaces" entry.
  - `Displays.<id>`: per-display overrides.
  - `Spaces.<id>`: per-Space overrides, with `Default` and `Displays.<id>`
    beneath.
  - `SystemDefault`: the factory fallback.
- **The shape of an entry.** Each entry holds a `Desktop` with
  `Content.Choices[]` and `LastSet`; `Idle` is the screen saver. A still-image
  choice has these keys:
  - `Provider = com.apple.wallpaper.choice.image`
  - `Files = [{ relative = "file:///…" }]`
  - usually `Configuration = <data>`, a nested binary plist holding placement
    and colour. It may be absent on newer releases.
- **WallpaperAgent loads the store when it starts.** Restart it after editing
  the store, with `launchctl kickstart -k gui/<uid>/com.apple.wallpaper.agent`
  or `killall WallpaperAgent`. Each display shows a dark flash of about 0.35 s
  while the agent restarts.
- **NSWorkspace splits the store.** A set through NSWorkspace or System Events
  turns the store into per-Space entries, which switches "Show on all Spaces"
  off. After that, sets reach only the current Space. Sources:
  pnitijarasrat/dotfile#102 (tested on 14.1 with 6 Spaces) and Apple forums
  threads 814926 and 784381.
- **macOS 13 and earlier use the Dock's `desktoppicture.db` (SQLite).** Its
  `data` table holds the values of every preference, not only image paths. The
  widely copied `UPDATE data SET value=…` therefore overwrites unrelated
  preferences, so we do not edit this database. The toast says that only the
  current Space was changed.

## Design
**Why we return to all-Spaces mode:** this layout follows the tested
reference, pnitijarasrat/dotfile#102.
- We set `AllSpacesAndDisplays.Desktop.Content` to the entry macOS itself
  just wrote for the image, and empty `Spaces` and `Displays`.
- We do not rewrite every override in place, because that would leave "Show
  on all Spaces" off. Any new Space would then get the old default, and the
  next NSWorkspace set would split the store again.
- `SystemDefault`, `Idle`, `Type`, dates and unknown keys are left untouched.
- We never fabricate a `Configuration` blob.

**Avoiding a lost update.** WallpaperAgent saves the store asynchronously. A
rewrite read before that save would be clobbered by it. So:
1. Snapshot the store before the NSWorkspace call.
2. Wait (at most 3 s) for an entry that shows the image *and* differs from
   the snapshot at the same location. An entry that showed the image before
   (another Space showing the same picture) does not count.
3. On timeout, write nothing and report "current Space only".
4. If every display already showed the image, NSWorkspace persists nothing.
   The current store's own entry for the image is then the template, and there
   is no pending save to wait for.

**Verifying.** After the restart we wait 1.5 s and re-read the store. We report
success only if the all-Spaces entry and every override still show the image.

**Writing safely:**
- The temp file is uniquely named in the same directory (`tempfile`).
- It gets the original file's permissions and is synced with `sync_all`.
- It is then renamed over `Index.plist`. The temp file is removed on any
  failure.
- A symlinked or non-regular `Index.plist` is refused.
- A process-wide mutex serialises the whole flow.

**Other gates:**
- If any display failed the NSWorkspace set, the store is not rewritten.
- The `/private/var`, `/private/tmp` and `/private/etc` firmlink prefixes are
  normalised away before a store URL is compared with the path from
  `canonicalize`.

**Reporting.** `set_as_wallpaper` returns `WallpaperOutcome { notice }`, which
the frontend shows as an info toast. Linux and Windows always return
`notice: null`.

## Unverified without a Mac
- The exact nesting under `Spaces`. The walker finds `Desktop.Content.Choices`
  up to depth 5.
- Whether macOS 26 (Tahoe) still uses this store.
- Whether WallpaperAgent persists within 3 s on slow machines. If it does not,
  the toast says so and nothing is written.

## Checking it
`cargo test --lib wallpaper` runs on every host. It also tests the atomic
replace against a real temp directory: modes and symlinks on unix.

macOS cross-clippy from Linux:
1. Stub the vendored `explorer-avif` cmake build script locally, for example
   with an early `return` from `main` behind an env var. Never commit this.
2. Run:

   ```
   CC=true AR=true TURBOJPEG_SOURCE=explicit TURBOJPEG_LIB_DIR=<empty dir> \
   TURBOJPEG_INCLUDE_DIR=<empty dir> cargo clippy --target aarch64-apple-darwin --all-targets -- -D warnings
   ```
