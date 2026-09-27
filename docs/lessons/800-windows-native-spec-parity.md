# #800 — Windows native-spec parity audit

Audit of every Linux-gated native spec in `e2e-tauri/specs`, done for W4.2–W4.4
of `docs/execution-plans/architecture-overhaul-remaining.md`.

## Enabled on Windows (`smoke (windows-latest)`)

These specs exercised only DOM/app-state behavior or app-observable receipts,
not a Linux-specific OS capability, so they now run on both `linux` and
`win32`:

The first Windows run did execute these describes rather than silently skip
them, and exposed four fixture defects before the advertised outcomes: three
file-list tests used POSIX-only path suffixes, preview resize used the same
suffix assumption, terminal resize embedded unescaped backslashes in a CSS
attribute selector, and the existing-file watcher case also used a POSIX-only
suffix. Native entry lookup now goes through the shared exact-path
`entryPathSelector`, whose contract covers Windows backslashes and quotes.
That initial run still provided valid passing evidence for both config reload
cases, ConPTY Ctrl+Q ownership, and watch-root replacement; it did not provide
resize, composite-focus, or existing-file preview-refresh evidence.

A later Windows run reached the repaired selectors and exposed three more
runner assumptions. WebDriver's element-click request selected a composite row
without moving DOM focus; because that alone does not establish how a real
pointer behaves, the Tab-cycle test now sends pointer down/up at the row and
still requires both its roving tab stop and DOM focus to advance. The shared
native profile had retained an open preview, so Space closed an already
populated preview; the resize test now establishes a closed baseline first.
Splitting one drag across two `performActions` requests stopped at the first
move on the observed runner, without proving why. The test now represents the
physical drag as one W3C action sequence, with a pause that lets the first
resize and terminal reflow settle before its second move. Terminal fixtures use
the runner-owned cleanup root because Windows cannot remove the shell's current
working directory until the native process exits.

- `file-list-focus.spec.ts` — Tab/Shift+Arrow/F2 keyboard focus ownership.
- `preview-resize.spec.ts` — zoomed pointer/keyboard dock resize and
  fullscreen containment.
- `terminal-resize.spec.ts` — PTY/ConPTY panel resize. Adapted its scrollback
  fixture command: `seq 1 80` doesn't exist under `cmd.exe` (the default
  Windows shell, via `%COMSPEC%`); Windows uses the built-in
  `for /l %i in (1,1,80) do @echo %i` instead.
- `terminal-key-ownership.spec.ts` — Ctrl+Q/Quick Open/Command Palette/tab
  chord ownership while the terminal is focused. The raw-byte key probe was
  Unix-only (Python's `termios`/`tty`, unavailable on Windows Python); Windows
  now runs a `powershell -Command` probe using
  `[System.Console]::ReadKey($true)`, which delivers the same ASCII 17 control
  byte for Ctrl+Q that ConPTY forwards to a console reader.
- `directory-watch-recovery.spec.ts` — watch-root recovery after a directory
  is replaced with a new file identity. Assertions are on the app's own
  watcher receipts and rendered entries plus `fs.Stats.ino` (populated on
  Windows NTFS via `GetFileInformationByHandle`, not just on Linux), not on
  any OS-specific watch introspection.

## Stay Linux-only, with the missing Windows capability

- `directory-watch-lifetime.spec.ts` — asserts directly on kernel inotify
  watch descriptors via `/proc/<pid>/fdinfo` (`e2e-tauri/native-resources.ts`).
  Windows has no documented per-process introspection of the
  `ReadDirectoryChangesW` watch handles notify's Windows backend holds, so the
  exact-watch-count claims (acquired / reclaimed / retired) have nothing to
  assert against.
- `git-watch-renderer-crash.spec.ts` — crashes the renderer by sending a real
  signal to its descendant processes (`terminateRendererDescendants`,
  `e2e-tauri/native-process.ts`) and then confirms lease reclamation through
  the same `/proc`-based inotify introspection as above. Neither the
  signal-based crash simulation nor the introspection has a Windows
  implementation.
- `directory-listing-errors.spec.ts` — simulates a listing failure with POSIX
  permission bits (`chmod 0o000`). Windows uses ACLs; `fs.chmodSync` there only
  toggles the read-only attribute and cannot deny directory listing.
- `file-recovery.spec.ts`, `file-history-lifetime.spec.ts`,
  `file-forward-history.spec.ts`, `move-retirement.spec.ts`,
  `file-move-recovery.spec.ts` — exercise `durable-copy-recovery` /
  `durable-move-recovery`, which are `cfg(unix)` / `cfg(target_os = "linux")`
  production features with no Windows or macOS admission adapter (ADR 0020;
  plan decision D2 keeps this Linux-only for the release). Several of these
  also use `exactApplicationPid`'s `/proc`-based process identity.

## Not gated (already cross-platform, out of scope for this audit)

`hostile-filenames.spec.ts` and `git-cache-lifetime.spec.ts` already run on
every platform; they adapt their fixture names/paths per-platform rather than
skipping entire `describe` blocks.

## W4.3 — ConPTY terminal acceptance

`terminal-key-ownership.spec.ts` and `terminal-resize.spec.ts` are enabled on
Windows as above. `terminal-input-order.spec.ts` (#709) already runs on every
platform except `win32` for a documented reason (input reordering repro
specific to non-Windows delivery); left as-is since W4.3 only asked for key
ownership and resize.

## W4.4 — Config replacement and autoreload

`config-autoreload.spec.ts` was not gated to Linux, but wrote its fixture
files in place (`fs.writeFileSync` over the existing file). It now uses
`atomicReplace()`: write a sibling temp file, then `fs.renameSync` it over the
target — the same write-temp-then-rename pattern a real external editor or
dotfile manager uses, and atomic on every platform via
`ReplaceFileW`/`MoveFileExW` semantics on Windows and `rename(2)` on POSIX.

The backend config watcher (`src-tauri/src/config_watch.rs`) already watches
the containing `config_dir` with `RecursiveMode::Recursive` rather than
individual files with a file-level watch, and `watched_config_name` already
has a canonicalize-and-compare fallback for renamed/atomic-write cases. So the
watcher did not need a product fix for this case — the atomic rename lands
inside the already-watched directory and is delivered as an ordinary
create/rename event under the existing name. This differs from the
already-documented symlink-retargeting gap in
`docs/lessons/604-config-autoreload-symlinks.md`, which is about the watch
*target* moving outside the watched root, not the *replacement mechanism* for
a file that stays in place.
