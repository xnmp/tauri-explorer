# Windows native smoke can fail before its GUI tests

The first failing dev run for #1222 failed only `Windows Rust lint`; Linux
native smoke passed. PR #1218 introduced `Source::uses_webkit_source`,
`Registry::bind_html5_context`, and `Registry::can_adopt_html5` without matching
their Linux-only production callers' compilation gates. Cross-platform unit
tests used these helpers, but the ordinary Windows library did not. Clippy's
`-D warnings` therefore rejected the library for dead code.

The CI recovery reverts PR #1218 as a unit. This also rolls back its Trash
permanent-deletion actions, shortcut defaults and Linux HTML5 drag transport;
those changes need to be reintroduced with Windows lint qualification. The
pre-existing in-app Trash listing/restore and native drag infrastructure remain.

The regression oracle is the existing producing-layer Windows compiler gate:

```sh
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features e2e-hooks,e2e-webview2-attach -- -D warnings
```

On Linux, `cargo xwin clippy` with `--target x86_64-pc-windows-msvc` runs the
same warning check. Test compilation alone is insufficient: `cfg(test)` callers
can hide dead code in the ordinary library build. Keep the warning gate fatal;
do not add dead-code allowances or remove the gate to recover CI.
