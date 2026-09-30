//! Guards the local Wry patch (#817, #864).
//!
//! `[patch.crates-io]` only applies while the patched version satisfies the
//! Tauri runtime's Wry requirement. When a Tauri upgrade needs a newer Wry,
//! Cargo resolves the registry crate and merely warns that the patch was not
//! used, which silently restores the per-window WebKit descriptor leak. These
//! checks turn that into a test failure on every platform's `cargo test`.
//! See `vendor/wry/TAURI_EXPLORER_PATCH.md` for the upgrade procedure.

use std::fs;
use std::path::Path;

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// The `[[package]]` blocks for `name` in a Cargo.lock.
fn lock_packages<'a>(lock: &'a str, name: &str) -> Vec<&'a str> {
    let header = format!("name = \"{name}\"\n");
    lock.split("[[package]]\n")
        .filter(|block| block.starts_with(&header))
        .collect()
}

fn field<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key} = \"");
    block
        .lines()
        .find_map(|line| line.strip_prefix(&prefix)?.strip_suffix('"'))
}

fn vendored_version() -> String {
    let manifest = fs::read_to_string(manifest_dir().join("vendor/wry/Cargo.toml"))
        .expect("vendor/wry/Cargo.toml is readable");
    let package = manifest
        .split("[package]")
        .nth(1)
        .expect("vendored manifest has a [package] table");
    field(package, "version")
        .expect("vendored manifest declares a version")
        .to_owned()
}

#[test]
fn wry_resolves_to_the_vendored_patch() {
    let lock =
        fs::read_to_string(manifest_dir().join("Cargo.lock")).expect("Cargo.lock is readable");
    let packages = lock_packages(&lock, "wry");
    assert_eq!(
        packages.len(),
        1,
        "exactly one wry package should be locked; a second one means the vendored patch is not used"
    );
    let package = packages[0];
    assert_eq!(
        field(package, "source"),
        None,
        "wry resolves from a registry, so the vendored #817 patch is unused; \
         re-vendor the Wry version Tauri now requires (see vendor/wry/TAURI_EXPLORER_PATCH.md)"
    );
    assert_eq!(
        field(package, "version"),
        Some(vendored_version().as_str()),
        "Cargo.lock's wry version differs from the vendored crate"
    );
}

#[test]
fn vendored_wry_keeps_the_weak_ipc_capture() {
    let source = fs::read_to_string(manifest_dir().join("vendor/wry/src/webkitgtk/mod.rs"))
        .expect("vendored webkitgtk backend is readable");
    let handler = source
        .split("fn attach_ipc_handler")
        .nth(1)
        .expect("vendored Wry still defines attach_ipc_handler");
    let before_signal = handler
        .split("connect_script_message_received")
        .next()
        .expect("attach_ipc_handler connects the script message signal");
    assert!(
        before_signal.contains("webview.downgrade()"),
        "the IPC signal handler must capture a weak WebView (#817); re-apply the patch after re-vendoring"
    );
}

#[test]
fn lock_parser_distinguishes_path_and_registry_packages() {
    let lock = "version = 4\n\n[[package]]\nname = \"wry\"\nversion = \"0.57.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"wry-sys\"\nversion = \"1.0.0\"\n";
    let packages = lock_packages(lock, "wry");
    assert_eq!(packages.len(), 1);
    assert_eq!(field(packages[0], "version"), Some("0.57.0"));
    assert!(field(packages[0], "source").is_some());
}
