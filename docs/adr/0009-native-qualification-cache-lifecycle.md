# ADR 0009: Native qualification cache lifecycle

Status: Accepted

Governs: `.github/workflows/e2e-tauri.yml`

## Context

Native qualification compiles the embedded Tauri application before exercising
the real GUI. Its Rust target directory is expensive to rebuild, but restoring
outputs from another compiler or publishing partial outputs after an early
failure can waste more time or hide an incomplete cache behind a successful
restore.

Qualification failures also need evidence while independent GUI work continues.
The cache policy and its diagnostics are therefore part of the qualification
process lifecycle, rather than an incidental CI optimization.

## Decision

- The Rust target cache key includes runner operating system and architecture,
  a digest of the exact compiler identity, and Cargo/target input hashes.
  Registry and Git dependency caching remains separate from target caching.
- Target restoration uses the exact key only. Cargo remains responsible for
  fingerprinting source changes within a compatible target directory.
- Native contracts may continue long enough for the independent embedded build
  and GUI checks to report, but a failed native contract is made fatal by an
  explicit final gate.
- The target cache is saved only when native contracts and the embedded build
  succeeded. A GUI failure does not prevent that save because those build
  products remain safe to reuse; a contract or build failure never publishes
  them.
- Contract diagnostics upload before GUI qualification. A final cache-outcome
  artifact records save eligibility/outcome and end-to-end timing. Both
  artifacts retain cache identity, hits, storage and transfer estimates, Cargo
  metadata/fingerprints, commands, timings, revision, runner, and toolchain so
  two equivalent runs can be compared.

## Consequences

- Stable-toolchain changes naturally produce a cold compatible target cache
  instead of restoring incompatible artifacts.
- A failed GUI run can warm the next equivalent run without treating the GUI
  failure as success.
- Reviewers can retrieve contract evidence before a long GUI outcome and pair
  the recorded provenance from two equivalent runs without relying on a mutable
  log view.
