# Eighth AI-operation review handover

All changes remain uncommitted on feat/ai-ops-auto-settle. User prohibits commits.
Contract remains docs/lessons/ai-ops-auto-settle-review.md. The implementation
and regression details are appended there under the eighth-review entry.

## Production changes

- Portable writable file flushes in durable_dir; host spool sealing/recovery use
  the helper. Test observations and writable-mode assertion run on Linux.
- Independent completion intent precedes output writes; original reply bytes
  precede completed-pending; pending DB witness stores exact
  status/length/hash. Recovery accepts pre-manifest crash images, validates hashes,
  reconstructs the manifest and avoids Unknown settlement of the original.
- Atomic settlement/bound-spool release; directly discoverable idempotent sweeps
  repair legacy split commits and retry physical collection with quota retained.
- Explicit custody and reservation are atomic. Custody-less calls capture the
  unique nonreleased admission for the provider package (including new digest
  replacements and execution-fenced recovery); ambiguous calls fail before spawn.
  Removal collects tied unbound bytes. Operation-scoped recovery checks custody
  before preferring the admission's original generation on request-counter reset.
- Removal raw-image loss notices inspect custody before deferred collection and
  do not let unreadable files veto explicit removal.
- Shared real recover_in/resume_in seams, real event capture, phased writer and
  lifecycle crash seams support the strengthened model. Compatible delivery
  acknowledgment cannot regress a Completed job to Recovering.

## Fail-first evidence

Original eighth findings: /tmp/hops-eighth-spools-red.log (15 passed, 3 failed),
/tmp/hops-eighth-flush-red.log (0 passed, 1 failed).
Additional production counterexamples reproduced and fixed:
/tmp/hops-eighth-unbound-nonzero-red.log,
/tmp/hops-eighth-host-notice-red.log,
/tmp/hops-eighth-metadata-red.log,
/tmp/hops-eighth-combined-red.log,
/tmp/hops-eighth-reincarnation-red.log,
/tmp/hops-eighth-removal-io-red.log, and
/tmp/hops-eighth-latest-red.log (24 passed, 2 failed: partial pending metadata and
cross-operation request-ID collision), and /tmp/hops-eighth-partial-combined-red.log
(0 passed, 1 failed: partial metadata plus failed completion commit).
/tmp/hops-eighth-ownership-red.log (28 passed, 2 failed: ambiguous reservation
and replacement/fenced-admission ownership), and
/tmp/hops-eighth-native-collision-red.log (0 passed, 1 failed: replacement counter
reset blocked the custody-filtered original). The latter was reproduced in real
RPC with three failing provider-upgrade native cases; all three passed after the
original-generation selection fix.

## Limits and fixture counterexamples

Preexisting ambiguous unbound metadata cannot identify which of several consumers
paid for the bytes. Preserve those originals until ownership is resolved or all
possible owners release; individual physical removal for that historical case
cannot be claimed. Prospective ambiguity is refused before any paid process starts.

The random model exposed fixture errors too: reuse of a reverse request ID after
a failed reservation (the real SDK increments every attempt), allowing new CLI
execution after terminal provider rejection, and treating an expected cancelled
late reply after durable rejection as a conservation failure. Keep these distinct
from production counterexamples; deterministic regressions and strict independent
image/reply oracles cover them.

The final independent review also caught forced old-owner hints in both model
operation-scoped spool lookups. They bypassed the no-owner request-counter priority
branch and prevented a compatible new-digest unbound reply from delivering. The
replacement delivery regression failed first in
/tmp/hops-model-replacement-delivery-red.log (`valid original never delivered`),
then passed after both lookups switched to None, matching native RPC. The earlier
80-family deep pass is preserved as /tmp/hops-model-deep-owner-filter.log; do not
use it as proof of the corrected endpoint coverage.

## Verification status

Final verification completed. Results on the final source:

- Rust run 1: `test result: FAILED. 2235 passed; 1 failed; 79 ignored; 0 measured;
  0 filtered out; finished in 50.81s` (/tmp/hops-eighth-rust-1.log). Only the known
  unrelated creation_is_lazy test failed.
- Rust run 2: `test result: FAILED. 2235 passed; 1 failed; 79 ignored; 0 measured;
  0 filtered out; finished in 54.80s` (/tmp/hops-eighth-rust-2.log). Only the same
  known unrelated creation_is_lazy test failed.
- An earlier full run had terminal::tests::pty_shell_runs_in_cwd_and_emits_output
  output timeout (/tmp/hops-eighth-rust-before-transport-1.log). Its isolated
  retry passed in 0.02s (/tmp/hops-eighth-terminal-isolated.log) and later full
  runs passed that test.
- Spools: `test result: ok. 31 passed; 0 failed; 0 ignored; 0 measured; 2281
  filtered out; finished in 0.36s` (/tmp/hops-eighth-spools-final.log).
- Model normal: `test result: ok. 20 passed; 0 failed; 1 ignored; 0 measured; 2294
  filtered out; finished in 10.53s` (/tmp/hops-model-normal-final.log).
- Corrected deep: `model required coverage: 80 transitions >= 3 hits; ack-crash=6`;
  `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2314 filtered out;
  finished in 331.07s` (/tmp/hops-model-deep-final.log).
  Independent review parsed required=80, present=80, minimum=3, missing=[],
  acknowledgment-crash=6, request-counter-collision=3, replacement-unbound=8.
  Both no-owner lookup routes and exact original delivery assertions confirmed.
- `Native isolated recovery: 22 passed; 0 failed` (/tmp/hops-eighth-native-final.log).
  `Private native environments: 22/22 app and fixture provider verified`
  (/tmp/hops-eighth-native-verification.log).
- Affected Vitest: `Test Files 8 passed (8)`; `Tests 118 passed (118)`;
  `Duration 1.63s` (/tmp/hops-eighth-vitest.log).

Full Windows cargo check: exit 101 before application compilation, failed custom
C build commands for turbojpeg-sys, bzip2-sys, libz-sys, ring, zstd-sys and aws-lc-sys
(/tmp/hops-eighth-windows-check.log). Independent compilation of
the production durable_dir module to MSVC metadata passed
(/tmp/hops-eighth-windows-durability.log); this is not native Windows qualification.
Code-map coverage: 728/728 tracked source files, no unresolvable refs.
git diff --check passed.

Strict deep command (80 required families, minimum three actual hits each):
`CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --manifest-path
src-tauri/Cargo.toml --lib ai_operations_reference_state_machine_deep -- --ignored
--nocapture`, 1024 randomized cases up to 100 steps plus a directed coverage campaign.
Windows command: `CARGO_TARGET_DIR=/var/tmp/te-wt2/target-xcheck cargo check --offline
--manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --lib`.

Native tests must run under the separate Xvfb/Openbox/D-Bus/XDG harness;
never on the user's physical desktop. Harness /tmp/hops-run-native.sh and
/tmp/hops-check-native-display.py check the private process environment. The
observer follows children of every Rust worker thread and rechecks PIDs across
exec; require both the actual app and fixture-provider environment verification.
