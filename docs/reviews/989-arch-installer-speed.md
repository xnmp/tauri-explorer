# Arch installer speed verification (#989)

Base commit: `bde6081d304890e7a3080bd17466543f41862328`.
Implementation branch: `fix/arch-installer-speed`.

## Method

Run the actual installer and system makepkg against the real checkout with
timestamped combined stdout/stderr. A PATH-scoped sudo fixture permits only
credential validation and the expected `pacman -U` call; the latter checks that
the produced package exists and reports interception without installing it.
The final runs execute an immutable copy of the wrapper's text with its normal
script path/arguments. Frontend generation, native compilation, AVIF support,
package creation and compression all remain real.

Profiling harness and full local logs: `/tmp/arch-install-profile/`.
Final source snapshots: `/tmp/arch-install-profile/final-source/`.

## Baseline

`baseline.log`: successful unchanged-checkout installer run, 368.11 seconds total.
Frozen JavaScript dependency preparation took 0.062 seconds; the frontend took
about six seconds. Rust reported `Finished release profile [optimized]` after
359 seconds. Packaging/compression took about two seconds. No installed software
was changed.

The baseline retained Cargo's target directory; recompilation was caused by
fresh embedded frontend output, including SvelteKit's generated version stamp.

## Measured result

| Run | Total | Native build | Frontend |
| --- | --- | --- | --- |
| Original unchanged checkout (`baseline.log`) | 368.11 s | 359 s | Rebuilt |
| Updated priming run (`stable-epoch-prime.log`) | 360.26 s | Full release compile | Rebuilt |
| First repeat (`stable-epoch-repeat.log`) | 353.19 s | 345 s | Verified reuse |
| Settled repeat with Cargo tracing (`stable-epoch-settled.log`) | 8.00 s | 0.24 s | Verified reuse |
| Settled repeat without tracing (`optimized-repeat-confirmed.log`) | 8.14 s | 0.21 s | Verified reuse |

The settled unchanged repeat is **45.2 times faster**, a **97.8% reduction**
against the original unchanged-checkout run. Both settled runs recreated the
package successfully and neither compiled the app. The native binary SHA-256
stayed `ff3fd052a4bf7d4fee752cd51fb79f5eecb310d5aeb5619dfd255ceec2f8b8c8`
from the priming run through both settled repeats. makepkg additionally strips
the packaged copy: its SHA-256
`4ee92b250487b53c85d52233ee5f9501c7500e8b41ae2504fa2dda432bf98dc4`
matches staging and the preceding package. The source and packaged ELF `.text`,
`.rodata` and `.data` sections are byte-identical.

The first repeat still compiled. Independent inspection found Tauri's
content-addressed embedded asset cache files newer than the first library
compilation's dependency cutoff: those files were generated during macro
expansion. This is consistent with a one-time Cargo catch-up; it is not
eliminated by frontend reuse. An isolated real Rust proc-macro fixture reproduced
the same timing and Cargo's explicit changed-file dirty reason, followed by a
fresh third run. Production attribution remains an inference because the first
repeat lacked a dirty trace. The following traced run reported native fingerprints
fresh, and the next untraced run confirmed reuse. No native orchestration,
release profile, AVIF feature or Tauri compilation behavior was changed.

Full baseline and untraced repeat logs, plus a clearly labeled rendering of
their key lines, are saved in `screenshots/fix/arch-installer-speed/`.
Trailing whitespace on timestamped blank log lines is normalized for Git.

## Correctness checks

- `bunx vitest run tests/arch-frontend-build.test.ts tests/arch-install-script.test.ts`: 29 behavior tests pass.
- `bun run check`: zero errors and warnings.
- `bash -n arch_install.sh PKGBUILD`: passes.
- `python3 docs/code-map/validate.py --coverage`: all source files covered.
- Independent adversarial reviewer: content/environment/toolchain/symlink/output invalidation, failed-build receipt retirement, clean checkout, concurrent helper exclusion, surviving-child lock ownership and wrapper lock release confirmed.

The regression test first failed on the original PKGBUILD because two native
build checks performed two frontend builds on an unchanged checkout. It passes
with frontend reuse while retaining both native checks and dependency preparation.

An early real repeat run still missed reuse. Independent instrumentation of two
actual makepkg fixture runs confirmed identical file/tool fingerprints and
exactly one varying environment input: makepkg's generated `SOURCE_DATE_EPOCH`.
The wrapper now defaults it to the source revision date, falling back to
`package.json` mtime for source archives and preserving explicit caller values.
This keeps the exact environment key and uses source-based package timestamps.

## Independent adversarial review

- **CONFIRMED:** settled performance (both actual runs); input/output/dependency/environment/toolchain invalidation; clean-checkout behavior; receipt retirement after failure; helper and installer lock lifetimes; native/package byte and ELF-section consistency; ordinary PKGBUILD frontend rebuilding.
- **CONFIRMED mechanism, PLAUSIBLE production attribution:** generated proc-macro inputs newer than compilation start cause a Cargo catch-up build. A real Rust fixture reproduced the dirty reason; production timestamps and subsequent fresh runs agree.
- **REFUTED:** cold-build speedup or a guarantee that the first repeat after frontend regeneration is fast.

Independent local artifacts: `/tmp/arch-review-binary-09p6qrt8/`,
`/tmp/arch-review-codegen-timing-nmo78rep/` and
`/tmp/arch-review-environment-deg3fc9n/`. The reviewer edited no production source.

## Scope

Only unchanged frontend output is reused. Cold builds and source changes still
perform the existing optimized release compilation. These measurements exclude
interactive sudo authentication and actual pacman installation time. GUI testing
is unnecessary for this build-only change; no desktop was used.
