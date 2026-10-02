# #846 macOS clipboard provider probe

This small crate imports the application's actual `error.rs`, `clipboard/backend.rs`,
`clipboard/change_counter.rs` and `clipboard/macos.rs` through `#[path]`. It has no
copied provider, substitute error type, or additional native fixture. It runs exactly
the existing ignored `native_clipboard_ownership_round_trip` test, including the
current test-only diagnostics, even when the implementation fails.

Run on a disposable hosted Mac only; this replaces its general pasteboard:

```sh
bash docs/reviews/846-macos-clipboard-probe/run-probe.sh
```

The workflow uploads complete provenance, compilation/test-list and native output
on both success and failure. Its dedicated Rust cache contains compiled dependencies;
the native test always executes. It does not use application qualification results
or a cached application binary. `verify-provenance.py` checks every locked dependency's
version/source/checksum against the app lock, separately checks critical direct versions,
verifies all four production source bindings, rejects dirty measured inputs, and logs
checkout SHA, toolchain and source/lock hashes. Root dependency updates require updating
the probe's pinned versions and lock too.

Only file-list provider publication/read-back and counter ownership are exercised.
The probe omits Tauri, frontend startup, IPC, the coordinator/worker, Finder interaction
and image codecs (`clipboard-rs`'s image feature does not govern file-list methods).
The full application macOS Clippy, general Rust suite and ignored native fixture remain
required for final acceptance. This fast loop cannot substitute for those results.

Local cross-target compilation without touching any clipboard:

```sh
cargo clippy --locked --manifest-path docs/reviews/846-macos-clipboard-probe/Cargo.toml --tests --target aarch64-apple-darwin -- -D warnings
```
