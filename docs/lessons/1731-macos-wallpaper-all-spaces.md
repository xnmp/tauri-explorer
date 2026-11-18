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
    queue (`dispatch2`) through `bounded::hand_off`. On the main thread it
    runs inline, never waiting on its own queue.
  - The main thread must start the work within 10 s. Work not started by
    then is abandoned: nothing changed, and if the main thread reaches it
    later it does nothing.
  - Work that has started is already taking effect, so its result is
    awaited up to 20 s more instead of being reported as a failure. Only
    work still running after that is reported as an error ("some may still
    change").
  - AppKit itself can block the main thread inside `setDesktopImageURL`
    (for example while it decodes a large image). Nothing in the app can
    bound that; the wait above only bounds the blocking-pool thread.
- **Subprocesses are bounded too.** `sw_vers`, `launchctl` and `killall`
  run while the flow holds its mutex, so each is killed after 10 s
  (`bounded::run_command`, which also drains both pipes so a chatty child
  cannot block).
- **macOS 26 store layout.** An image choice has `Files = []`. The URL lives
  in the choice's `Configuration`, a nested property list.
  - The parser takes the single distinct `file://` URL in that plist,
    following nested plist data. Several URLs, none, or a blob beyond the
    bounds (256 KiB, 512 values, nesting depth 8) means "not recognised",
    so an unfamiliar configuration is never mistaken for the image.
  - `Files`, when it has one entry, still wins (macOS 14/15).
- **Parse cost must be bounded before parsing** (`plist_bounds.rs`).
  - `plist::Value` expands a binary plist's shared references into a tree.
    A 256-byte `Configuration` whose objects each reference the next one
    twice took 1.2 s at 22 levels, doubling per level.
  - A deeply nested store overflowed the stack, at the latest when the
    parsed value was dropped.
  - Limits checked on the parsed value come too late. So the store (max
    16 MiB, also enforced when reading the file) and each `Configuration`
    are checked first: binary plists are walked through their offset table
    (expanded value count and depth, memoised, iterative, cycle-checked),
    and XML is scanned for element count and depth.
  - A store with more than 2048 desktop entries is not recognised.
- **macOS 26's reloaded all-Spaces form counts as success**
  (`kept_everywhere`) only when every Space and display is accounted for:
  - there is no `AllSpacesAndDisplays.Desktop`;
  - every recorded desktop entry shows the image;
  - every Space and display in the store holds a desktop entry;
  - every Space and display recorded *before the rewrite* is still there.
  A Space that holds only a screen saver, or one the agent dropped, would
  fall back to an all-Spaces desktop that does not exist; that is not proof.
  The pre-rewrite shortcut still requires true all-Spaces mode, so a
  per-Space store is always rewritten.
- **The rewrite keeps screen savers.** It removes every per-Space and
  per-display `Desktop` override but keeps each override's `Idle` (screen
  saver) choice. An override left with no `Idle` is removed whole, and so
  is a container left empty. Unverified: that the agent then resolves the
  Desktop from the all-Spaces entry while keeping the per-Space `Idle`. If
  it does not, the post-reload check reports it.
- **A missing or unreadable store while waiting for macOS's save** may be
  mid-save, so the wait keeps polling. The last reason is reported only if
  no usable store appears within the 3 s wait.
- A store with no `AllSpacesAndDisplays` section at all gets macOS's own
  entry for the image (with its `Idle`/`Type`) as that section, never a
  fabricated one. A store with neither that nor any override is refused.
- **Reloading WallpaperAgent.** `launchctl kickstart -k
  gui/<uid>/com.apple.wallpaper.agent` is refused under SIP (the default),
  so the fallback is `killall WallpaperAgent`; launchd restarts it.
  - `killall` sends SIGTERM. The agent may save its in-memory state as it
    exits, over the rewritten store. SIGKILL would rule that out but is
    not what the spec asked for. This is unconfirmed; the three-store
    warning below would show it.

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
agent at the same moment. Another is the SIGTERM save described above. The
three-store warning is there to tell the cases apart next time:
- If "agent kept" matches the store before the rewrite, the agent's own
  save won.
- If it matches neither, something else wrote the store.

## Known, not handled
- A choice that is a folder or a Shuffle of images is not a single still
  image. It is never recognised as showing the image, so it is never used
  as the template, and a Space showing one blocks the all-Spaces success
  check. This predates #1731.

## Unverified without a Mac
Everything macOS-specific was written and checked on Linux only:
- The exact key names inside a macOS 26 `Configuration` (the parser does not
  depend on them, only on there being one `file://` URL).
- That the main dispatch queue is drained promptly while a Tauri window is
  open, and the 10 s + 20 s bounds in practice.
- That `Idle`-only overrides keep their screen saver while the Desktop
  follows the all-Spaces entry.
- The reloaded per-display/per-Space form, as described in the spec.

## Checking it
- `cd src-tauri && cargo test --lib wallpaper` runs on every host:
  - the store parser (14/15 and 26 layouts; malformed, empty, huge,
    exponentially shared and deeply nested inputs);
  - the hand-off and subprocess bounds;
  - the flow decisions and the notice text.
- macOS cross-clippy from Linux (needs `rustup target add
  aarch64-apple-darwin`):

  ```
  CC=true AR=true CXX=true CMAKE=true TURBOJPEG_SOURCE=explicit \
  TURBOJPEG_LIB_DIR=$(mktemp -d) TURBOJPEG_INCLUDE_DIR=$(mktemp -d) \
  cargo clippy --target aarch64-apple-darwin --all-targets -- -D warnings
  ```
