# Arch installer speed — completed implementation

Saved after the long profiling/review session, using a short post-work timer
per the repository handover preference.
This records the state before the subsequent request to commit and merge;
consult Git history for the later landing state.

## State

- Checkout: `/home/chong/Repos/tauri-explorer`.
- Branch: `fix/arch-installer-speed`, from dev `bde6081d304890e7a3080bd17466543f41862328`.
- Issue: <https://github.com/xnmp/tauri-explorer/issues/989>; evidence/results updated, still open until landing on dev.
- Implementation and verification complete, but changes are **uncommitted**. No PR or merge requested/performed.
- Actual privileged installation was intercepted. No installed software or desktop state changed.
- Preserve preexisting changes: `AGENTS.md`, PKGBUILD's version bump `1.11.1` → `1.11.2`, and unrelated untracked files. Do not stage those indiscriminately.

## Implementation

`arch_install.sh` enables verified frontend reuse, provides `--rebuild`, holds a
checkout-wide flock through installation, preserves the sudo keepalive/cleanup,
and stabilizes makepkg's SOURCE_DATE_EPOCH using the source timestamp while
preserving caller overrides. Archive extraction beneath an unrelated repository
uses package.json mtime rather than the unrelated repository's history.

PKGBUILD dispatches to `scripts/build-arch-frontend.mjs` only when the wrapper
enables reuse; ordinary makepkg/CI builds retain unconditional frontend building.
Frozen dependencies are still installed and the native Tauri/Cargo build always
runs with AVIF and the original optimized release profile.

The helper hashes source/config/dependency contents, full relevant environment,
Bun/Node versions and build output. Only PDF copies and Vite temporary outputs
are excluded. Receipts are removed before rebuilding and atomically published
only after success with unchanged inputs. OS locks and inherited build-child
descriptors prevent overlapping helper builds even after helper termination.

Tests: `tests/arch-frontend-build.test.ts`, `tests/arch-install-script.test.ts`.
Documentation: README, code maps, lesson989, review989.
Evidence: `screenshots/fix/arch-installer-speed/{before.log,after.log,installer-profile.png}`.

## Verification and scope

- Baseline real package build: **368.11 s**, Cargo359 s.
- Settled real repeats: **8.00 s** (traced) and **8.14 s** (untraced), Cargo0.24/0.21 s with no compilation.
- Approximately45.2 times faster for a settled unchanged repeat.
- Native binary hash unchanged; packaged executable matches staging/preceding package, executable/data ELF sections match the native binary.
- 29 targeted behavior tests pass, `bun run check` has no errors/warnings, Bash syntax passes, code maps cover609/609 source files, `git diff --check` passes.
- Independent reviewer confirmed cache/lock/failure contracts and actual performance/package consistency. Cold-build speedup and guaranteed first-repeat speed were explicitly refuted.

The first reuse after new embedded assets still took353.19 s. Production input
timestamps suggest Tauri proc-macro assets generated after compilation started
caused one Cargo catch-up. A real proc-macro fixture reproduced the exact dirty
reason and subsequent fresh build; production attribution is an inference because
that first repeat lacked tracing. Cold builds and source changes remain full
optimized compilation. No native architecture change was made.

Full verification record: `docs/reviews/989-arch-installer-speed.md`.
Local profiling harness/logs/snapshots: `/tmp/arch-install-profile/`.
Independent binary and proc-macro evidence:
`/tmp/arch-review-binary-09p6qrt8/`, `/tmp/arch-review-codegen-timing-nmo78rep/`.

If landing is requested later, review/stage only task-owned hunks/files and
preserve existing user edits. Close989 only after merging into dev. This is a
build-only change; no GUI test or active-desktop automation is appropriate.
