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


## Fourteenth review: acquisition/discard precedence and native preparation identity

Starting HEAD `4bd263b5`. Review 13 was read in full from
`/tmp/claude-1000/-home-chong-Repos-TraceExplorer/f4f074e8-00dc-47d2-b20d-ae1d367e1c92/scratchpad/revhops13.out`.
No commit or merge.

The shared terminal classifier now recognizes a committed provider discarded
receipt before the separate admission release. `Store::acquired` checks this
classifier inside the IMMEDIATE transaction that inserts acquisition evidence;
`observe_receipt` projects a losing provider discard to the verified acquired
transfer receipt through the same classifier and transaction boundary. First
commit wins: discard-first rejects acquisition; acquisition-first returns the
canonical acquired delivery. Provider-local discard can remain immutable without
blocking normal acquired reconciliation/release. Provider execution, diagnostics,
identity and revision guards remain enforced. Equal/lower/newer observations and
collection converge the winning outcome. Stored contradictory pre-fix discarded
receipts are integrity-checked first, then projected only for delivery comparison
and stale-return semantics; legacy acquisition evidence precedence is preserved. This prevents a
Terminal admission from holding custody/charges/slots behind incompatible durable
acquired evidence and discarded receipt history.

Fail-first: `model_provider_discard_and_acquisition_first_commit_wins_across_crashes`
fails at `committed provider discard must fence acquisition` before the production
fix. Log: `/tmp/hops-fourteenth-red-discard.log`. It now checks both orders with
process restart and power loss between every whole durable transition, acquired
provider acknowledgement, released disposition, exact acquisition winner,
zero charged custody/disk bytes and no operation claims.
The fixture keeps the provider-local discard independently from the host winner;
it never pretends that host rejection rolls back the provider receipt.

Explicit `ProviderDiscard` commit/release and `DiscardCrash` transitions also
participate in random exploration and the required directed deep campaign.
`model_discard_acquisition_races_at_internal_durable_barriers_converge` checks
12 schedules: process/power loss × three barriers × acquisition/discard paths.
Acquisition barriers are file sync, directory sync and evidence ledger commit;
discard barriers are receipt witness before commit, receipt ledger after commit,
and release before collection. The last asserts the original `.bin` still exists
and charges remain before restart, then all custody/charges/claims disappear.
Six additional acquisition-first schedules crash a losing discard observation or
acquired release at these barriers while the provider keeps returning discard.
The oracle independently records ledger commitment even when the API crashes
before returning the receipt. Precommit rollback and postcommit reply loss are
separate outcomes; no durable flag is inferred from successful return alone.

Both Linux native probes now create two captures and Accepting presentation jobs
owned by the production consumer generation, declare/route its image service
dependency, fill output capacity and prove one admission is refused before any
provider RPC. They preserve original broker generation/PID and job owner across
no-op enable or compatible provider upgrade, release blockers, then dispatch
both original captures through the actual native provider. Assertions verify
admission owners/descriptors, exact readable captured bytes and the provider's
logged request bodies. The upgraded package includes the same real executable
and compatible service export, so post-upgrade dispatch is native as well.
The existing private Xvfb/Openbox/D-Bus/XDG isolation and worker environment
assertions are retained; no active user desktop is touched.

Production was temporarily broken to retire only consumers owning captured
preparations. Both no-op enable and compatible provider upgrade probes failed
with `lifecycle retired the unaffected consumer broker`:
`/tmp/hops-fourteenth-red-preparation-noop.log` and
`/tmp/hops-fourteenth-red-preparation-upgrade.log`.
`lifecycle.rs` was restored byte-for-byte against
`/tmp/hops-fourteenth-lifecycle-before.rs`; no deliberate regression remains.
Unmutated strengthened native probes pass individually.

Independent adversarial review confirmed transaction precedence and native
preparation/RPC coverage. It found the acquisition commit-before-return oracle
gap and requested pre-restart proof of retained charged bytes; both were fixed
and are covered by the directed barrier regression. A further adversarial pass
found that rejection alone could strand acquisition-first work behind a provider
that permanently returns its locally durable discard. The failing-first test
`model_persistent_provider_discard_after_acquisition_converges_without_provider_rollback`
reported `valid original never delivered` before canonical projection; log:
`/tmp/hops-fourteenth-red-persistent-discard.log`. It now converges without any
provider rollback, acquired reply, synthetic Ack or explicit release.
Legacy older/equal/newer receipt/evidence conflicts also failed first (log
`/tmp/hops-fourteenth-red-legacy-discard.log`) and now converge. Same/newer-revision
execution metadata conflicts still fail and leave the stored receipt unchanged.
The earlier deep runner was stopped before full runs when the persistent-provider
gap was found; only the final runs below qualify the final code. Final review and
requested results follow.
Final independent read-only review: CONFIRMED atomic precedence, proof-backed
incoming/historical delivery projection, integrity/metadata/revision guards,
immutable provider-discard convergence, internal crash schedules and native
preparation-only mutation sensitivity. No remaining concrete blocker found.

Requested verification uses `CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops`.
Deep and both full lib runs are sequential (no executable replacement during
native subprocess probes), and full lib uses `--test-threads=8`.
Logs: `/tmp/hops-fourteenth-model-targeted.log`,
`/tmp/hops-fourteenth-model-deep.log`, `/tmp/hops-fourteenth-lib-{1,2}.log`,
`/tmp/hops-fourteenth-lint-arch.log`, `/tmp/hops-fourteenth-vitest.log`.

The first complete deep attempt after canonical projection exposed a pre-existing
model recapture ownership assumption and shrank to
`[SharedConsumerAdmit, Admit(1,true), CompatibleUpgradeCrash(false,5,false), Admit(0,false), RecaptureCrash(1)]`.
Targeted instrumentation reproduced `plugin incarnation was retired` before the
injected filesystem checkpoint (`/tmp/hops-fourteenth-red-recapture.log`). The
independent debug pass confirmed the crash helper bypassed the ordinary capture/
dispatch recovery callback owner resolution. It now reuses
`preparation_callback_owner` before arming the checkpoint. Production ownership
logic is unchanged. The minimized directed regression and new saved seed
`624b5ae4de4f985e1a0bb2b54b0d2f24e97ba485978acf5efd60ba7325924600`
are retained; the prior seeds are preserved. Initial failing deep log:
`/tmp/hops-fourteenth-model-deep-recapture-red.log` (236.62s).

The final deep run passes 1,024 random cases plus the directed campaign: all
133 required transition families reach >=3 hits; new discard commit/release hit
60/36, discard precommit/postcommit/collection crash hit 13/15/12.
The first two full lib runs then exposed an existing rejection-only assertion in
`orphan_import_acknowledge_and_discard_release_only_after_durable_evidence`.
The requested loser contract permits a convergent no-op; that test now checks
repeated losing discard replies preserve acquired disposition/receipt, exact
consumer bytes, revoked read grant and no operation claim. Production/model code
is unchanged by this test update, so the passing final deep run still qualifies.
Initial full logs are retained as `/tmp/hops-fourteenth-lib-old-contract-{1,2}.log`
(2333 passed / 2 failed / 79 ignored, 56.26s and 55.28s): the rejection-only
assertion and the known lazy-creation failure. Final full runs below follow the
contract assertion update.

Final requested commands:

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib ai_operations_reference_state_machine_deep -- --ignored --nocapture
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=8
# Full lib command executed twice sequentially.
bun run lint:arch
bunx vitest run tests/domain tests/state --maxWorkers=2
```

```text
Deep: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2413 filtered out; finished in 301.17s
Lib final 1: test result: FAILED. 2334 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 67.72s
Lib final 2: test result: FAILED. 2334 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 61.92s
Lint: arch-lint: clean
Vitest: Test Files  287 passed (287)
Vitest: Tests  2914 passed (2914)
Code-map coverage: 734/734 source files; zero unresolved references
```

Both final full lib failures are solely
`file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`
(`completed.warning.is_none()`). All new race, persistent discard, legacy repair,
metadata fencing, recapture ownership and native identity regressions pass in
both final full runs. Focused model suite: 60 passed / 0 failed / 1 ignored
(12.47s); the updated orphan-import no-op contract passes individually (0.08s)
and in both final full runs. Independent final test-only review confirmed that
its existing durability failures, replay-to-status and discard-first rejection
coverage remain intact while the new assertions prove acquired no-op outcomes.

`lifecycle.rs` remains byte-for-byte restored; `git diff --check` passes.
HEAD remains `4bd263b5`; no commit, merge, issue close or user-desktop action.
All eight changed files, including the new saved regression seed, remain
uncommitted in this working tree. The accepted pre-seal completion contract and
other documented model/platform limits in the thirteenth review remain unchanged.


## Fifteenth review: proof-backed legacy repair and provider acknowledgement model

Starting HEAD `9c5a7daa`, branch `feat/ai-ops-auto-settle`. Review 14 was read
in full from
`/tmp/claude-1000/-home-chong-Repos-TraceExplorer/f4f074e8-00dc-47d2-b20d-ae1d367e1c92/scratchpad/revhops14.out`.
No commit or merge. Both findings are addressed.

Completion takes the verified receipt returned by the shared terminal classifier,
not the receipt field in a potentially discarded admission. One IMMEDIATE
transaction repairs Terminal/Released admission phase and disposition, transfer
receipt, attention flag, existing successful provider receipt delivery/hash,
artifact/spool release intent, obsolete settlement/preparation markers and
non-Completed presentation. Existing Completed history remains unchanged. Historical provider execution/diagnostics/identity/
revision remain intact; absent receipts are not invented, and earlier running/
unknown receipts retain their earlier execution history. Completion uses the
historically verified consumer path even if the consumer later edits/deletes it.
Physical collection remains separate and keeps charges until unlink barriers
succeed. Committed discard terminalizes stranded presentation without asserting
that a possibly live native worker has ended. Error histories lacking a message
receive the validated provider failure reason or a safe no-replay fallback;
verified acquisition corrects that otherwise stranded errorless history too. Consumer completion events retain
the independent handoff-release ordering gate.

Automatic reconciliation classifies and repairs committed local terminal delivery
under the host action/IdleCallFence before any provider activity/status RPC. This
prevents an unavailable provider or exhausted RPC deadline from blocking local
repair. Pending Terminal operations still use original unpaid production
recovery. Candidate selection includes recoverable terminal jobs behind stale
discarded tombstones and already Completed rows with inconsistent delivery
bookkeeping, then removes repaired work from the automatic backlog.

Table-driven production regression:
`model_legacy_terminal_and_released_ledger_shapes_converge`.

| Axis | Enumerated values / contract |
| --- | --- |
| Admission | Terminal (no disposition/transfer); Released/discarded (no transfer); Released/acquired (matching transfer) |
| Provider receipt | Succeeded/discarded, succeeded/acquired, absent, succeeded/available, succeeded/unavailable, earlier running/none, earlier unknown/none |
| Acquisition evidence | Present or absent; acquired receipts/releases without matching evidence were never writable by either historical contract and are excluded |
| Job | Every JobState with null phase; Accepting/accepting, Running/running, Recovering/recovering, NeedsAttention/stopped or provider_result_discarded, Discarded/stopped or discarded, Error/stopped or delivery_failed or storage_full, Error/failed with/without error, Cancelled/consumer_removed or cancelled, Completed/complete; null-phase Error with/without error |
| Execution-release flag | Both 0 and 1, including legacy idle flags behind acquired/discarded tombstones |
| Completed history | Includes schema-permitted independent completion without acquisition evidence, with a real consumer copy. Preserve successful history; discard must not attach a no-output error. Shipped Trace consumers normally completed only after acquisition, but origin/dev host APIs allowed independent reports. |

Final continuation expands the table to 1,584 historical combinations checking terminal/correct presentation,
exact acquired bytes and path, canonical receipt/tombstone where applicable,
zero charged custody/disk bytes/operation claims, and repeated sweeps with no
new job revisions, recovery calls or automatic candidates. The port panics if
committed delivery consults provider activity; Released recovery cannot answer
status. Pending original delivery alone uses healthy fixture RPC.

`model_legacy_acquired_completion_repair_is_atomic_and_rejects_invalid_proof`
uses a SQLite trigger to abort the presentation write after earlier bookkeeping
writes. Admission/provider receipt/job/artifact inventory remain unchanged.
Mismatched evidence descriptors also reject with unchanged bookkeeping; restored
proof completes idempotently with the pinned run and original receipt revision.

The model now separates `provider_acknowledged` from `host_released`. Receipt
commit alone sets the former; restart preserves that provider receipt, and sweep
observes actual host release from the production ledger. The directed regression
`model_acquired_receipt_restart_sweep_releases_through_reconciliation` checks
`Admit → ProviderComplete → Acquire → AcquiredReceipt → Restart → Sweep`: before
sweep the provider receipt is acquired, the admission is Terminal and capacity is
held; automatic production reconciliation then releases custody and completes
history without synthetic Ack or lifecycle removal. The same trace participates
in the directed deep campaign.

Fail-first logs:

- `/tmp/hops-fifteenth-red-ledger.log`: original 192-case table failed 126 cases
  before production repair, including Released/discarded evidence-backed jobs.
- `/tmp/hops-fifteenth-red-model.log`: requested no-removal acquired-receipt trace
  failed with `valid original never delivered` before separating model state.

Intermediate focused checks caught the unsafe execution-release flag mutation
while a raw native writer remained active. The existing provider-rejection
regression remains unchanged and checks that correction. The standalone orphan
spool regression now asserts Released admission, terminal job and no operation
claims rather than the previous idle-settlement implementation's exact flag;
its no-paid-start, live independent writer, retained charge and final collection
assertions remain. The initial atomic test expected private trigger error text;
ledger errors are sanitized, so it now checks failure plus full rollback.
Logs: `/tmp/hops-fifteenth-model-targeted.log`,
`/tmp/hops-fifteenth-model-targeted-final.log`.

Independent adversarial review checked production transactions, evidence/receipt
integrity, historical coverage, provider-unavailable convergence, model state
separation and worker accounting. It identified the provider-RPC-before-repair
gap; that path now repairs before RPC. The final focused result is 68 passed / 0 failed / 1 ignored (29.57s), with
384 ledger combinations and zero failures. No remaining concrete blocker was
found in the final independent read-only review.

The first deep run exposed another fixture gap and minimized to
`[SharedConsumerAdmit, ProviderComplete(0), DiscardCrash(0,0,false)]`: a durable
provider-local discard survives a precommit host rollback, then its status retry
commits through production reconciliation. The fixture had not advanced its host
discard oracle on that retry and incorrectly reported automatic discard. A
separate read-only debugger independently confirmed the gap. The observer now
records explicit provider intent plus a matching durable discarded receipt/revision
before propagating reconciliation errors, never admission disposition or API
success alone. The minimized directed regression checks pre-sweep uncommitted
and post-sweep committed discard, followed by zero custody/charges/claims. Seed
`36efde3704e39caadf820032c1d222755c1d13ee0b8f5dafcf03cce9a72b2c28` is retained
alongside every previous seed. Log: `/tmp/hops-fifteenth-model-deep-precommit-red.log`
(169.91s).

The expanded errorless-history cases also failed first: the 384-case table had
33 failures, all Error/failed/null combinations, before safe terminal failure
reason/acquired correction. The same run reproduces the minimized discard trace.
Log: `/tmp/hops-fifteenth-red-errorless-and-precommit.log`. The second deep run found a separate collision-transition precondition gap:
`[Admit(1,false), Publish(1,2,true), Spool(1), Seal(0), DelayedReceipt(0,false),
Seal(0), Upgrade(true,true,false), Probe(true), ReplacementCollision(1)]`.
Instrumentation proved the affected operation was Failed, with a raw captured
reply but no valid paid output; the admission was Released/discarded and its
provider receipt failed/none. A replacement collision cannot demand preservation
of a legitimately rejected raw reply. The fixture now refuses this transition
for failed/cancelled or Released operations; production lookup is unchanged.
A directed failed/cancelled regression drives production GC, checks no rejected
operation custody before/after the collision attempt, and converges to zero
claims/charges. Existing successful bound/unbound collision coverage still
requires delivery of the exact original bytes. Independent debugging/review
confirmed this distinction. Seed
`ecb832fe048f8d0bcbb91ed7f6177e626aef8bb194bfc84750313ed929204d1b` is preserved.
Logs: `/tmp/hops-fifteenth-model-deep-collision-red.log` (171.16s),
`/tmp/hops-fifteenth-red-collision.log`; final focused log:
`/tmp/hops-fifteenth-model-targeted-final8.log`. The third deep run reached the same provider-discard oracle gap through
`Replay` rather than status:
`[Admit(0,false), PausedProviderMutation(1,0,0), ProviderComplete(0),
DiscardCrash(0,0,false), Replay(0)]`. The fix is centralized in
`Operation::observe_discard_commitment`: independent provider intent, no known
acquisition winner and full equality of the authenticated durable receipt with
the fixture's emitted discarded receipt. The common invariant boundary covers
every command/RPC publication path; status also observes immediately before
same-call consumer handoff or propagating a reply/release error. No host admission
disposition alone can authorize discard. The directed replay test checks
pre-replay false and post-replay true, then custody/charge/claim quiescence.
Independent debugging/review confirmed the root correction. Seed
`5932e4a2faa2ba31e54b63dcce37750c5de23fb7f0234488fec6bb0282a10335` is retained.
Log: `/tmp/hops-fifteenth-model-deep-replay-red.log` (195.91s).

A passing deep run then reached all 133 required transition families at >=3
hits (acquired-receipt-before-release=15, ack-crash=3): 1,024 random cases plus
the directed campaign, 268.57s. The first full lib run found the known lazy-
creation failure plus two existing contracts: 2338 passed / 3 failed / 79 ignored
(71.20s). Log: `/tmp/hops-fifteenth-lib-old-status-contract.log`.

The evidence-only recovery regression expected restoration of disposed host
bytes through provider recovery after acquisition already committed. It now
registers a parked presentation and verifies required local completion, exact
consumer bytes despite host-file deletion, canonical release/receipt, zero
operation claims, no provider activity/recovery, cached status, empty repeated
sweep and later acquired acknowledgement with unchanged Completed history.
The existing domain reconstruction coverage remains unchanged.

The second failure exposed a real retained-status regression: Released custody
was authoritative while the native worker accounting flag deliberately remained
unchanged. `image_call` now treats Released admissions as cache/replay authority
in addition to that execution flag, after the existing identity checks, matching
`recovery_retained_status`. Retained terminal status no longer calls the provider;
starts remain fenced without claiming a live worker ended. All 43 focused
automatic regressions pass (21.11s); log: `/tmp/hops-fifteenth-automatic-final.log`.
Independent final source/test review confirmed the guard and strengthened
outcome regression, with no remaining concrete blocker. The final deep and both
full lib reruns below follow this last production correction.

The deep rerun after the Released-status correction uncovered a pre-existing
fixture success-boundary gap:
`[SharedConsumerAdmit, Admit(0,false), DirectorySyncFailure(true),
Stage(2,false,false), ProviderComplete(2), PowerLoss]`. `ProviderComplete` had
published success from volatile complete bytes despite failed sealing and no
descriptor/completion identity. Power loss then changed the fixture to Unknown;
production correctly rejected the impossible Succeeded→Unknown observation.
Synthetic ProviderComplete now requires a sealed descriptor, committed seal or
recorded completion identity. Explicit authoritative Publish(Succeeded) remains
unchanged. The directed regression asserts no pre-seal success receipt and final
quiescence; independent debugging/review confirmed the accepted boundary. Seed
`5719da24968c35b081dc1e4c9ac9f8aa31f58d279f6b276a8748dd355249f0d7` is retained.
Log: `/tmp/hops-fifteenth-model-deep-unsealed-red.log` (233.19s). Final focused
model suite: 68 passed / 0 failed / 1 ignored (29.57s), all 384 ledger cases
converge. Production has not changed since the Released-status correction.

A further deep run found paused acquisition bypassing the consumer's durable
intent: `[Admit(0,false), ProviderComplete(0), CopyBeforeProof(0),
PausedMutation(0,1,0)]`. The normal copy had already committed its journal and
destination, but the manually paused fixture branch unconditionally rewrote it
and counted a second delivery. `consumer_copy_from` now shares descriptor/path
validation, existing-copy verification/sync and first-write accounting between
ordinary recovery and the paused acquisition branch. Its lazy source supplier
uses normal Store read for recovery and pre-mutation captured bytes for the
paused path. The latter still calls acquisition after the lifecycle mutation,
preserving the production removal/upgrade fence. No effect-counter suppression
is used. The directed regression checks one effect before/after the pause and
final quiescence; independent debugging/review confirmed the shared-intent fix.
Seed `597c4ffdde2610b9a8be986280c75cc2d8cdd837a443e7959d3cbe7f1209d9b8` is retained.
Log: `/tmp/hops-fifteenth-model-deep-paused-copy-red.log` (247.87s). Final focused
suite: 68 passed / 0 failed / 1 ignored (29.57s), with 384/0 ledger cases.

Continuation reviewed the entire uncommitted diff and the prior transcript tail.
A fresh initial targeted/full run confirmed the existing fixes: 62 model tests,
75 bridge tests; full lib 2342 passed / 1 known lazy-creation failure / 79 ignored
(64.18s). The prior log's two bridge failures did not reproduce.

Independent review falsified full historical job-shape coverage: verified
acquisition could remain Error/failed with a message, Cancelled/cancelled or
Discarded/discarded, including null phases; candidate selection could hide these
behind an already acquired tombstone. The expanded regression failed first:
1536 cases / 312 failures (`/tmp/hops15-cont-expanded-red.log`). Including
schema-permitted independent Completed reports produced 1584 cases / 316 failures
(`/tmp/hops15-cont-expanded-completed-red.log`), with four erroneous no-output
messages attached to completed consumer history. Completion now repairs every
non-Completed job from verified acquisition, evidence-backed terminal failures
remain automatic candidates regardless of phase/error, and discard preserves
existing Completed history. Ordinary consumer-observation terminal protections
remain unchanged; the presentation conventions document states the independent
proof-backed exception.

`released_acquired_replay_validates_request_with_legacy_execution_flag` also
failed first with recovery_stopped (`/tmp/hops15-cont-replay-red.log`). Released
start requests now validate their pinned semantic identity and downgrade to
cached status for either legacy execution flag, while non-Released stopped work
still refuses start. The test checks changed-prompt rejection before dispatch,
exact retained status, and unchanged consumer output.

Final cross-layer adversarial review found that the live frontend still rejected
newer host Completed events after ordinary Error/Cancelled/Discarded history.
The ledger repaired but the UI could retain its old terminal state until a
snapshot reload. The domain event merge now accepts trusted newer host
completion with an output path regardless of prior non-Completed phase, while
preserving identity, revision, malformed-event, dismissal and Completed-state
protection. Expanded domain/state regressions failed first: 11 failed / 21 passed
(`/tmp/hops15-cont-frontend-red.log`); focused verification passed 32/32
(`/tmp/hops15-final-targeted-frontend.log`). The live controller assertions check
Complete plus exact output path, cleared error, one initial snapshot, no reload
and no duplicate toast. Final independent source review confirmed all five
claims (atomic repair, quiescence, validated replay, live UI correction and
acknowledgement/release separation), with no remaining concrete blocker.

Final requested verification results follow below.

Requested Cargo target: `/var/tmp/te-wt2/target-hops`. Deep and full runs are
sequential, with full lib using `--test-threads=8`, so native subprocess probes
never race executable replacement.

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib model_tests -- --nocapture
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib service_bridge_tests -- --nocapture
bunx vitest run tests/state/native-plugin-jobs.test.ts --maxWorkers=2
# Final broad verification order:
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=8
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib ai_operations_reference_state_machine_deep -- --ignored --nocapture
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=8
bunx vitest run tests/domain tests/state --maxWorkers=2
bun run lint:arch
```

Final code verification, in the requested order after focused regression checks:

```text
# Targeted model (all 1584 ledger shapes converge; rollback, invalid proof and restart/sweep trace pass)
test result: ok. 62 passed; 0 failed; 1 ignored; 0 measured; 2360 filtered out; finished in 88.25s
# Targeted bridge (including both legacy execution flags and pinned-request rejection)
test result: ok. 76 passed; 0 failed; 0 ignored; 0 measured; 2347 filtered out; finished in 26.57s
# Targeted live frontend
 Test Files  1 passed (1)
      Tests  32 passed (32)
# Full lib 1
test result: FAILED. 2343 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 127.50s
# Deep model
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2422 filtered out; finished in 341.42s
# Full lib 2
test result: FAILED. 2343 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 144.73s
# Vitest domain/state, maxWorkers=2
 Test Files  287 passed (287)
      Tests  2923 passed (2923)
   Duration  24.34s (tests 45%, import 30%, transform 14%, setup 7%, worker 4%)
# bun run lint:arch
arch-lint: clean
```

Both full lib failures are exactly
`file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`
at `src-tauri/test_support/file_mutation.rs:475` (`completed.warning.is_none()`).
No other full-suite failures. The deep run covers all 133 required transition
families with at least three hits each; acquired-receipt-before-release has 15
hits. No production changes followed these passing targeted/deep results.
`git diff --check` is clean. All work remains uncommitted.

Logs for final continuation: `/tmp/hops15-final-targeted-{model,bridge}.log`,
`/tmp/hops15-final-model-deep.log`, `/tmp/hops15-final-lib-{1,2}.log`,
`/tmp/hops15-final-lint-arch.log`, `/tmp/hops15-final-vitest.log`.

Accepted pre-seal completion contract and other documented platform/model limits
remain unchanged. No commit, merge, issue close, deployment or user-desktop action.
