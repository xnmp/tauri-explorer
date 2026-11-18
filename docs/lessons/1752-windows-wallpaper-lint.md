# Windows native smoke failed in Rust lint

The first dev run after PR #1745 passed both native GUI suites, but Windows
`cargo clippy --all-targets --features e2e-hooks,e2e-webview2-attach -- -D warnings`
failed: `wallpaper::bounded::run_command` was unused in the library test build.
The module was enabled for tests on every host; its production callers were
macOS-only and its command tests were Unix-only. Linux therefore missed the
Windows dead-code error.

PR #1745 was the only merge since the preceding green native workflow. Revert
it to restore that known-green source, including its matching frontend command
contract and tests. This also rolls back its macOS 26 wallpaper improvements;
those need Windows all-target lint validation before being reintroduced.

## Re-land

The re-land restores #1745 and gates `run_command` to
`cfg(any(target_os = "macos", all(test, unix)))`, with its process imports
moved inside it. A Linux `clippy --all-targets` cannot show this failure.
Before merging, dispatch `rust-platforms.yml` and `e2e-tauri.yml` on the
branch: both run Windows all-target Clippy.
