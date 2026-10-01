# Atomic update API compatibility

Rust 1.99 deprecates atomic `fetch_update`, so latest-stable Clippy with
`-D warnings` rejects otherwise unchanged code. `try_update`, available since
Rust 1.95, is the equivalent API: the old method is an alias. Preserve the
success/failure memory orderings and checked arithmetic when replacing it.

Reference: https://doc.rust-lang.org/std/sync/atomic/type.AtomicU64.html

The failure appeared in copy-session nonce allocation and Git-watch test
failure counters. Existing copy-session and Git-watch contracts validate the
same allocation, exhaustion and retry behavior after the rename.
