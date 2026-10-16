#!/usr/bin/env bash
# ci-test-rust.sh — one ci.yml rust-suite target (fmt, clippy, tests), run
# through the test-result cache (scripts/test-cache.mjs ci:rust, #1176).
# RUST_SELECTION comes from scripts/rust-affected.mjs: ALL, NONE or the
# workspace members for `cargo test -p`.
set -euo pipefail
manifest=src-tauri/Cargo.toml
case "${RUST_SELECTION:?}" in NONE) exit 0 ;; esac
if [ "${RUST_SUITE:?}" = default ]; then
  cargo fmt --manifest-path "$manifest" --all -- --check
fi
cargo clippy --manifest-path "$manifest" --all-targets --features "${RUST_CLIPPY_FEATURES:?}" -- -D warnings
case "$RUST_SELECTION" in
  ALL)
    cargo test --manifest-path "$manifest" --features "${RUST_TEST_FEATURES:?}" ;;
  *)
    packages=()
    for p in $RUST_SELECTION; do packages+=(-p "$p"); done
    cargo test --manifest-path "$manifest" --features "${RUST_TEST_FEATURES:?}" "${packages[@]}" ;;
esac
