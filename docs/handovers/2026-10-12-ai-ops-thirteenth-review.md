# Thirteenth AI-operation review

Branch `feat/ai-ops-auto-settle`, base HEAD `ab5e4417`, repository `/var/tmp/te-wt2/hops`.
Review 12 was read in full from
`/tmp/claude-1000/-home-chong-Repos-TraceExplorer/f4f074e8-00dc-47d2-b20d-ae1d367e1c92/scratchpad/revhops12.out`.
No commit or merge. Findings 2 and 3 are addressed; finding 1's behavior is unchanged.

## Durable delivery classification (finding 2)

`Store::terminal_delivery_at` is the shared terminal classifier. It validates
committed acquisition evidence or the acquired provider receipt against the
pinned output before consulting a discarded admission disposition. The admission
release is a separate commit and is not proof of whether delivery happened.
Removal, release (including retries), success retention/discard fencing, automatic
settlement, acquisition retries, delivery failure reporting and completion repair
use this classifier. A provider discard cannot overwrite committed acquisition.
The existing release-phase gate for a consumer completion event to replace an
already settled host job remains separate from the delivery classification;
removal commits release and completion together.

Disable/uninstall now persists an acquired tombstone with the original transfer
receipt and completes the existing presentation job in the same transaction.
It releases custody without a delivery-loss notice or Error job. Equal acquired
receipt reconciliation after removal still succeeds. Completion uses the
historical path from already verified/fsynced acquisition evidence; subsequent
consumer deletion or editing cannot undo delivery or veto removal.

The model has a separate `AcquiredReceipt` transition: acquisition evidence ->
provider acquired receipt commit -> crash -> removal, with no admission release
in between. Random exploration and the directed coverage campaign include it.
`acquisition_committed` independently records consumer acquisition, separate from
provider acknowledgement. Invariants require acquired removal, Completed history,
and no loss notice for any durably acquired output, including evidence alone.
Directed regressions cover consumer/provider disable and uninstall, exact delivered
bytes, later receipt reconciliation, evidence-only delivery and subsequent consumer
deletion of its copy.

Fail-first logs:

- `/tmp/hops-thirteenth-red-acquired.log`: removal produces `Some("discarded")`
  instead of `Some("acquired")` before the fix.
- `/tmp/hops-thirteenth-red-deleted-copy.log`: completion repair vetoes removal
  with `Service state: artifact path is unreadable` before historical path lookup.

## Production broker identity (finding 3)

The two identity regressions observe production `Broker::generation()` via the
active broker registry and confirm the original native worker PID remains live.
They no longer assert equality of the fixture-owned incarnation map. The provider
upgrade probe also proves the affected provider really was retired.

On Linux each probe runs the same test executable in a dedicated private Xvfb,
Openbox, D-Bus and XDG profile, with X11 forced and Wayland unset. The native worker's
actual `/proc/<pid>/environ` verifies the inherited display/backend, private D-Bus
address and private XDG config root. Compositor sockets/signatures are removed
and the subprocess is bounded by a 45-second timeout. No user
workspace, window, clipboard or compositor interaction is performed. Non-Linux
runs retain the model preparation checks but do not qualify native broker identity.

Production was temporarily broken and restored:

- No-op enable retired and restarted the enabled broker. The production equality
  assertion failed with equal package/digest but different incarnations
  (`1526273621088705` -> `1526273621088706`).
  Log: `/tmp/hops-thirteenth-red-noop-broker.log`.
- Upgrade also retired every unaffected enabled broker. The production registry
  assertion failed with `lifecycle retired the unaffected consumer broker`.
  Log: `/tmp/hops-thirteenth-red-unaffected-broker.log`.

`lifecycle.rs` is restored exactly; neither deliberate regression remains.

## Documented limits: finding 1 contract decision and objection

The atomic rename of the fsynced temporary completion sidecar to `completed.json`
is the success commit point. The following directory barrier additionally protects
that publication against power loss. Before the rename, even complete stdout whose
file and directory entries have been fsynced cannot establish successful completion:
the CLI exit status exists only in host memory, and the host cannot distinguish
those bytes from a partial capture after a crash. A crash before the seal settles
silently as Unknown, releases charges and never replays paid generation. Sealed
success must preserve and deliver its identical original. SQLite completion identity
is derived metadata and does not define the success commit.

Review 12 objects that this contract can delete paid output from an exit-zero CLI
whose complete stdout/stderr and directory entries were durable before the first
seal rename. It graded that loss P1 and argued that the earlier supplied contract
did not require the later seal. The user explicitly chose the atomic-seal contract
above and requested no finding-1 behavior change. That pre-seal loss is therefore
an accepted documented limit, not a delivery guarantee or an unresolved fix in
this review. Future reviews should evaluate against this explicit decision.

Model/Store test names and comments explicitly identify atomic seal rename as the
commit point and pre-rename crash as silent Unknown with charges released. Existing
first-seal crash/power-loss outcomes are unchanged. Existing limits from review 12
remain: transport starts answer synchronously; arbitrary consumer intent/partial-copy
crashes and real provider unpaid recovery are not fully modeled. Native identity
qualification is Linux-only.

## Verification

Independent adversarial review confirmed the requested acquired-receipt crash
interleaving, shared classification, actual native identity observation and both
mutation failures. It discovered the acquired-copy deletion veto, verified its
failing-first log and historical-evidence fix, and found no remaining concrete
defect. Its review was read-only code/log inspection; the coordinator ran tests.
Focused regression result before final deep/full runs:
`test result: ok. 54 passed; 0 failed; 1 ignored; 0 measured; 2353 filtered out; finished in 11.31s`.

Initial full-lib runs exposed an overbroad refactor: removing the release-phase
gate let a consumer completion event replace stopped history before provider
acknowledgement. The existing event-ordering regression failed as expected. Its
ordering contract is retained with a separate `handoff_released` boolean; whether
delivery occurred is still derived solely from the shared durable classifier.
Independent review agreed this preserves the established presentation contract
without weakening the requested removal interleaving.

Initial full results were 2327 passed / 2 failed / 79 ignored (50.70s and 55.33s):
the ordering regression plus the known lazy-creation test. The ordering regression
now passes in isolation: `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured;
2407 filtered out; finished in 0.03s`.
Logs: `/tmp/hops-thirteenth-lib-{1,2}.log`, `/tmp/hops-thirteenth-event-ordering.log`.
Final deep run: 1,024 random cases plus the directed campaign; all 128 required
transitions reached at least three actual hits (`ack-crash=3`,
`acquired-receipt-before-release=12`). No new regression seed was saved. The
existing stderr-directory-sync seed is preserved.

Final requested result lines are recorded below.
Requested Rust commands use `CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops`.
Deep and full lib runs are sequential to prevent executable replacement during
native subprocess probes. Full lib uses `--test-threads=8`.

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib ai_operations_reference_state_machine_deep -- --ignored --nocapture
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=8
bunx vitest run tests/domain tests/state --maxWorkers=2
```

```text
Deep: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2407 filtered out; finished in 269.94s
Lib final 1: test result: FAILED. 2328 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 55.63s
Lib final 2: test result: FAILED. 2328 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 51.69s
Vitest: Test Files  287 passed (287)
Vitest: Tests  2914 passed (2914)
Code-map coverage: 734/734 source files; zero unresolved references
```

Both final lib failures are solely the known
`file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`
(`completed.warning.is_none()`). The completion-event ordering regression,
all acquired-removal regressions, atomic-seal boundary regressions and both
real production broker identity probes pass in both final lib runs.

Logs: `/tmp/hops-thirteenth-model-deep-final.log`,
`/tmp/hops-thirteenth-lib-final-{1,2}.log`, `/tmp/hops-thirteenth-vitest.log`,
`/tmp/hops-thirteenth-map.log`, `/tmp/hops-thirteenth-model-targeted-final.log`.
The earlier passing deep run is `/tmp/hops-thirteenth-model-deep.log` (259.67s);
the final deep and both final lib runs followed the ordering correction with no
source changes or overlapping Cargo rebuilds. `git diff --check` passes.
No commit, merge, issue close, deployment, user-desktop action or macOS/Windows
runtime qualification. All changes remain in the working tree.
