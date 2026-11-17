# #1731 — Set as Wallpaper on macOS 26 (Tahoe) displays and Spaces

Follow-up to `1441-macos-wallpaper-all-spaces.md`, which still describes the
store, the all-Spaces rewrite and the lost-update guard.

## Symptoms on macOS 26
- The first display changed, then the action reported a failure. The JXA
  per-display step returned the screen count as a string, so the JSON parse
  of its report failed *after* the current display had already changed.
- Other Spaces never changed. The store parser read the image only from a
  choice's `Files[0].relative`, which macOS 26 leaves empty.
- When the rewrite did work, the post-reload check called it a failure:
  the reloaded agent expands all-Spaces mode into one entry per display and
  Space, with no `AllSpacesAndDisplays.Desktop`.
- The toast said "current monitor", which named the wrong cause.

## Findings
- **The per-display step is plain AppKit.** objc2
  `NSWorkspace.setDesktopImageURL:forScreen:options:error:` for each
  `NSScreen` returns a typed `Result`; no script output to parse.
  - NSScreen and the desktop-image calls run on the main thread. The command
    runs on Tokio's blocking pool, so the work is queued on the main dispatch
    queue (`dispatch2`) and awaited for at most 10 s. On the main thread it
    runs inline, never waiting on its own queue.
  - A block still pending at the deadline is marked abandoned and does
    nothing if the main thread reaches it later.
- **macOS 26 store layout.** An image choice has `Files = []`. The URL lives
  in the choice's `Configuration`, a nested property list.
  - The parser takes the single distinct `file://` URL in that plist,
    following nested plist data. Several URLs, none, or a blob beyond the
    bounds (256 KiB, depth 8, 4096 nodes) means "not recognised", so an
    unfamiliar configuration is never mistaken for the image.
  - `Files`, when it has one entry, still wins (macOS 14/15).
- **macOS 26's reloaded all-Spaces form counts as success**
  (`Coverage::EveryRecordedSpace`): no `AllSpacesAndDisplays.Desktop`, at
  least one per-display/per-Space entry, and every entry shows the image.
  The pre-rewrite shortcut still requires true all-Spaces mode, so a
  per-Space store is always rewritten.
- A store with no `AllSpacesAndDisplays` section at all gets macOS's own
  entry for the image (with its `Idle`/`Type`) as that section, never a
  fabricated one. A store with neither that nor any override is refused.
- **Reloading WallpaperAgent.** `launchctl kickstart -k
  gui/<uid>/com.apple.wallpaper.agent` is refused under SIP (the default),
  so the fallback is `killall WallpaperAgent`; launchd restarts it.

## Reporting
- `macos::set_wallpaper` returns `Result<Option<Partial { user, detail }>>`.
  `user` is one of two notices; `detail` (screens, errors, why other Spaces
  were left alone) goes only to the log.
  - "Could only change wallpaper on some displays" when any display failed.
  - "Could only change wallpaper on the current Space" otherwise (including
    macOS 13 and earlier, and an unknown version).
- `mod.rs` (`macos_outcome`) logs every macOS result and gives the UI
  `WallpaperOutcome.notice`; `system-actions.ts` shows it as one info toast.
- If the post-reload check fails, a warning logs `macos_store::describe` of
  the store before the rewrite, what was written, and what the agent kept.

## Unreproduced: the reload brought back the old wallpaper
Once, after the reload, the agent showed the previous wallpaper again. It
could not be reproduced. One suspect is an external script, such as a
dotfiles theme switcher, that rewrites the same store and restarts the
agent at the same moment. The three-store warning above is there to tell
the cases apart next time: if "agent kept" matches neither the store before
the rewrite nor what was written, something else wrote the store.

## Unverified without a Mac
Everything macOS-specific was written and checked on Linux only:
- The exact key names inside a macOS 26 `Configuration` (the parser does not
  depend on them, only on there being one `file://` URL).
- That the main dispatch queue is drained promptly while a Tauri window is
  open, and the 10 s bound in practice.
- The reloaded per-display/per-Space form, as described in the spec.

## Checking it
- `cd src-tauri && cargo test --lib wallpaper` runs the store parser (14/15
  and 26 layouts, malformed, empty and huge inputs), the flow decisions and
  the notice text on every host.
- macOS cross-clippy from Linux (needs `rustup target add
  aarch64-apple-darwin`):

  ```
  CC=true AR=true CXX=true CMAKE=true TURBOJPEG_SOURCE=explicit \
  TURBOJPEG_LIB_DIR=$(mktemp -d) TURBOJPEG_INCLUDE_DIR=$(mktemp -d) \
  cargo clippy --target aarch64-apple-darwin --all-targets -- -D warnings
  ```
