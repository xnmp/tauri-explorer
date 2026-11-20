# Native crate rules

All Tauri commands must be `async fn` (root `CLAUDE.md`). Most modules sit flat
in `src/`, so rules for some of them live with their feature:

| Module | Rules |
| --- | --- |
| `git_*.rs`, `github.rs`, `git_avatar.rs` | `src/lib/components/git-graph/CLAUDE.md` |
| `search_cache.rs`, `search.rs`, `files/fs_watcher.rs`, `system.rs` (`open_recycle_bin`) | `src-tauri/src/files/CLAUDE.md` |
| `renderer_owner.rs` | `src-tauri/src/renderer_owner/CLAUDE.md` |
| `user_report.rs`, `user_report_github.rs` | `website/api/CLAUDE.md` |
| `main.rs` (`processEntryMs`), startup logging | `e2e-tauri/CLAUDE.md` § Native qualification |
| `archive.rs` (SCM archive) | `src/lib/components/CLAUDE.md` § SCM |

Window creation paths (Rust main, fresh child, parked warm window: `main.rs`,
`window_launch.rs`, `warm_pool.rs`) must seed the requested title before
visibility; the page's reactive `window-title` sync then follows the active
explorer path (`src/lib/state/CLAUDE.md`).

## Unclean-exit marker (`session_marker.rs`, #1686)

Every orderly exit path must run `release_process_resources` (it disarms the
session marker first): `RunEvent::Exit`, the updater's Windows `on_before_exit`,
and the Unix signal path in `termination_signals.rs`; an unprevented
`ExitRequested` disarms already, so a teardown hang killed by the user is not
reported. A new path that exits without it makes the next launch report "did
not exit cleanly". Only the main process of a release build arms or reviews
markers (`session_marker::enabled`: debug builds opt in with
`TAURI_EXPLORER_SESSION_MARKER=1`; `e2e-hooks` builds never, since their
drivers SIGKILL the app); `start` sits after the portal branch in setup.
Liveness is the OS file lock, never a PID; markers also record the installation
(`build`), so two installs of one version never judge each other. Only
foreground windows take the crash report (`claimLaunchCrash`). In-process tests
release a marker with `abandon`, not `drop`: a sibling test's fork can share
the descriptor, and so the lock, until it execs.

## Crate and test layout

- Rust test modules included with `#[path]` from production modules belong in `src-tauri/test_support/`, not Cargo's auto-discovered `src-tauri/tests/`. Keeping source-included modules under `tests/` makes `cargo clippy --all-targets` compile them again as standalone integration crates, where their `super`/`crate` imports are invalid.
- The native crate is a desktop application library with no Rust doctest examples; keep `[lib] doctest = false` so shared qualification target caches cannot feed a zero-test rustdoc harness mixed-feature Tauri artifacts. Unit and integration tests remain under ordinary `cargo test` targets.

## Portable tests

Unix subprocess fixtures must execute checked-in launchers and read generated
scripts as shell input. A concurrent fork can retain a freshly written script's
writable descriptor until exec, causing Linux `ETXTBSY` even after `fs::write`
returns. The companion-audio fixture uses a per-test symlink to a stable launcher
and tests extraction with its generated input held open for writing (#1838).

Cross-platform batch-worker tests must derive absolute paths from `tempfile`
instead of Unix literals such as `/drive/a`. Windows treats those literals as
root-relative, so batch admission rejects them before the behavior under test
runs (see `docs/lessons/1599-windows-native-contract-regression.md`).

Gate a platform-only Rust test module as a whole, including its imports and
helpers. Gating only its test functions can leave unused imports under Windows
`cargo clippy --all-targets -- -D warnings`. The child-env compiler regression
imports the production source; `CHILD_ENV_TEST_TARGET=x86_64-pc-windows-msvc bunx
vitest run tests/child-env-compile.test.ts` checks Windows metadata without a
linker when that Rust standard-library target is installed (#1179).

Tauri Rust listeners (`app.listen`) are not a lossless test oracle: an emit
contending with any other emit on the same app is parked until a later emit
with a listener flushes it. Inject a sink for completion events (#1215).

Use private XDG config/data/cache directories for the native library suite:
rename completion consults installed provenance plugins, so an inherited host
profile can change its warning result.

## PTY tests (`terminal.rs`)

PTY output and exit notifications come from independent threads. Native tests
that inspect the complete transcript must wait for the output channel to close
as well as for the child exit; an exit notification does not mean the last
output callback has run. Keep those waits bounded and retain terminal cleanup
on assertion failures.
When forcing output delivery to follow exit, gate a test-side forwarding
consumer, never the production PTY reader: read backpressure can prevent the
shell from exiting. Include output larger than the PTY buffer to catch this.
For cwd/lifecycle tests, observe initial shell output before writing input;
startup typeahead has separate regression coverage.

## Git discard tests (`git_discard.rs`)

External-filter discard tests must check index/worktree cleanliness with native
Git. libgit2 does not run external clean filters, so its status can report a
restored smudged file as modified when metadata forces a rehash. Force a stat
cache miss in the fixture rather than relying on checkout timing (#1637).

## Config watch (`config_watch.rs`; #938, ADR 0004)

Config autoreload tests must write through the canonical target of any symlinked config file or theme directory; watching the link itself does not prove inotify observes the target.

Config-watch retargets must restore every surviving descendant after retiring a
recursive ancestor: notify's inotify backend removes descendant native watches
even if they were separately registered. Apply this restoration only to inotify;
exact-root backends such as Windows retain descendants and re-registering them
can leak native callback owners. Keep obsolete descendant cleanup obligations
until each removal succeeds, including after partial ancestor failures.
Include the permanent config-directory
watch when it is nested under that ancestor, and retain failed restorations for
retry. The Linux contracts in `src-tauri/test_support/config_watch_nested_roots_test.rs`
drive the production handover synchronously before writing canonical targets;
a receipt before ancestor removal can otherwise hide lost coverage (#938,
ADR 0004).
The public integration regression in `src-tauri/tests/config_watch_nested_root_test.rs`
also runs against the real refresh worker. It waits for native ancestor retirement
through `/proc/self/fdinfo`, then uses a first-ever bookmarks callback as an
inotify event-loop barrier before probing the canonical nested settings target.
Keep source-included Rust test filenames ending in `_test.rs` so the publication
gate recognizes them, and retain the public integration test when testing with
the entire implementation file reverted.
Run `bun run test:config-watch` from the repository root to execute both the
watcher ownership contracts and public nested-root/symlink integration tests.
The local harness command file is ignored and may disappear between checkouts;
keep the reproducible test entry point in `package.json`, and configure the local
harness to run it alongside `bun run test`. Frontend Vitest alone does not
exercise the Rust watcher acceptance criteria.
Pending config-watch removals are cleanup obligations, not confirmed coverage.
On a return retarget, complete uncertain cleanup before registering the root
again; otherwise an unregister error after native removal can leave that root
permanently unwatched, or an error before removal can duplicate native owners.
If cleaning the returning root removes the previous plan's descendants, restore
their coverage on registration rollback. The return/failure contracts live in
`src-tauri/test_support/config_watch_cleanup_return_test.rs` (#938, ADR 0004).

## GTK drag receiver acknowledgement

Vendored Wry must acknowledge accepted filesystem URI receipt as well as later
motion: GTK delivers selection data asynchronously, potentially after the final
pointer motion. A stationary release then needs no further Over to negotiate
Copy. Keep non-file URNs on DOM transport and preserve context/time admission.
The production callback regression is in `tests/helpers/platform-drag-intent.ts`
(#1806); real native filesystem outcomes remain in `e2e-tauri/specs/file-drag.spec.ts`.
