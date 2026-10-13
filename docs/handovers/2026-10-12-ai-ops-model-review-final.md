# Automatic settlement model review

Repository `/var/tmp/te-wt2/hops`, branch `feat/ai-ops-auto-settle`.
The user explicitly requested no commits. All work remains uncommitted.

## Contract and verification approach

Preserve every successful original for unpaid recovery; never replay Unknown.
Settle no-output work only after both workers are proven inactive. Explicit
disable/uninstall and incompatible replacement release/cancel every admission,
terminalize jobs, and publish at most one undelivered notice. Compatible
replacement preserves originals, including complete host-only CLI replies.
Quota eventually equals live reservations plus retained physical data, survives
unlink/fsync failures and modeled power loss, and converges without restart.
Live frontend history accepts authoritative recovered completion without run IDs.

The Proptest 1.11 dependency was added offline. The optional state-machine crate
was absent offline, so the test uses the reference-state-machine pattern with
shrinkable command vectors. The regular property runs 64 cases/up to 40 commands;
the ignored deep variant runs 1024 cases/up to 100 commands. Production Store,
service bridge, automatic reconciliation and lifecycle mutations execute;
transport/native preflight are infrastructure fakes. Independent outcome, bytes,
validity, durability, worker, delivery and removal truth drives assertions.
SQLite transactions remain real and FULL-synchronous. TestFs models unflushed
directory removals and dirty stage writes, not arbitrary database corruption.

See [the model handover](2026-10-12-ai-ops-reference-model.md) for commands,
invariants, retained seeds and four genuine shrunk production counterexamples.
Every final shrunk trace begins with one real admission:

1. `Sweep; Stage(0,false,false)` — collector deleted an original recovery writer's
   writable stage. Shared root-level writer ownership now protects reopen/GC.
2. `Sweep; DirectorySyncFailure(true); Upgrade(false,false,false)` — failed
   physical cleanup blocked incompatible consumer replacement. Opening defers
   cleanup while preserving conservative accounting.
3. `Stage(0,true,false)` — valid retained original with Unknown provider knowledge
   never recovered. The scheduler selects unpaid recovery from validated custody.
4. `Sweep; Upgrade(false,true,false); DirectorySyncFailure(true); Probe(true)` —
   a newer cached Running observation revoked the durable idle execution fence.
   Only original success can restore released custody.

## Seven requested findings

1. Durable host-spool ledger, reservation/pin before path publication, synced
   complete reply manifest, original-generation recovery and lifecycle-scoped
   removal replace broker-owned temporary-only custody. Upgrade cannot clear the
   sole original. Both roles have real-broker original-byte delivery regressions,
   including Unknown/lost replies and unbound legacy replies after probe outages.
2. Service invocation and recovery check the original lifecycle lease around
   activation and dispatch. The exact disable/re-enable interleaving was introduced
   by branch commit `22eddca4`: origin/dev also omitted the lease recheck, but its
   drain rejected mutation with live leases. It is now fenced regardless.
3. A newer validated same-identity stopped/delivery-failed/storage-full → Completed
   frontend correction requires a delivered path but allows a null run ID. Pure
   reducer and live-controller regressions prove convergence without reload.
4. Retained artifact custody validates complete PNG contents and pinned descriptor,
   rather than nonzero stage size or sealed metadata. Invalid stages settle and
   collect under worker-idle proof.
5. Recovery validates original bytes before acquiring stage/seal budget. Missing
   succeeded originals keep success identity while releasing execution/input
   claims and reducing inactive reservation to physical bytes. Sweep/reopen agree.
6. GC and stage-finalization retries sync every parent directory even on NotFound.
   Accounting is deleted/shrunk only after the barrier; failed barriers keep the
   previous conservative charge. Power-loss regressions restore unsynced entries.
7. The old preservation-only matrix was renamed. Its new outcome matrix invokes
   actual automatic recovery in both roles/every phase and asserts original bytes,
   acquired custody, Completed jobs, empty claims and no new paid start. Native
   tests exercise LiveAutomatic::recover itself.

All seven had fail-first regression evidence. Store finding 4/5/6 red/green logs:
`/tmp/hops-model-store-before.log`, `/tmp/hops-model-store-after.log`.
Finding 2 provenance, red/green and capacity/process regressions are in
[the admission handover](2026-10-12-ai-ops-admission-and-process-boundaries.md).
Host-spool additional targeted discoveries are in the durable-spools handover.

## Additional targeted discoveries

- Cancelled old service leases still consumed all replacement service capacity.
  Capacity counts are lifecycle-revision scoped; ownership remains until Drop.
- CLI exit 0/full output could lose to a concurrent owner cancellation before
  host exit polling. Owned process paths give the observed original exit
  precedence and preserve bytes; generic Git cancellation semantics are unchanged.
- A detached inert pipe holder could prevent EOF after the original leaf emitted
  a complete PNG and exited zero. The drain deadline returned an error and lost
  captured bytes. Owned draining now preserves capture/exit, including when one
  reader finished before the other timed out. Normal provider image validation
  remains mandatory; the process helper does not label raw bytes as valid images.
- All timed-out status answers recorded the provider incarnation but zero failed
  attempts, because deadline-bound store IO preceded retry bookkeeping. The
  bounded mutex update now precedes that read; a fresh pass performs idle proof
  and settles without sending another status after the budget is exhausted.
- Stage-finalization retry compacted quota after a NotFound stage without syncing
  its directory. It now uses the same durable retry discipline as collection.

Independent agents reviewed the model oracle, live worker fences, active-writer
collection, original IO errors, spool authority/durability and process boundaries.
Default-parallel bridge fixtures needed a test-only profile guard because their
identical singleton package IDs collided across filesystem profiles. Within-test
interleavings still execute concurrently; production action guards are unchanged.

## Completed evidence before final broad runs

Normal model `/tmp/ai-model-final-all.log`:
`test result: ok. 7 passed; 0 failed; 1 ignored; 0 measured; 2275 filtered out; finished in 8.53s`

Deep model `/tmp/ai-model-deep-final.log`:
`test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2282 filtered out; finished in 267.73s`

Affected Vitest `/tmp/hops-model-vitest-final.log`:
`Test Files 8 passed (8)`; `Tests 118 passed (118)`; `Duration 7.82s`.

Final Rust run 1 `/tmp/hops-rust-final-1.log`:
`test result: FAILED. 2206 passed; 1 failed; 77 ignored; 0 measured; 0 filtered out; finished in 41.40s`

Final Rust run 2 `/tmp/hops-rust-final-2.log`:
`test result: FAILED. 2206 passed; 1 failed; 77 ignored; 0 measured; 0 filtered out; finished in 43.49s`

Both used the exact requested offline command with default parallelism. Both
failed only the known unrelated `creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`
at `src-tauri/test_support/file_mutation.rs:475`. No relevant failures remain.

Final native batch `/tmp/hops-model-native-final.log`:
`Native isolated recovery: 20 passed; 0 failed`. This includes final timeout and
storage-full source, compatible/incompatible upgrades of both roles, host-only
and lost-reply originals, legacy unbound output, and delayed disable admission.

Native testing used private Xvfb/Openbox, separate D-Bus/XDG, x11, no Wayland
session, and verified actual app/helper DISPLAY. No active desktop interaction
was performed. Final exact-module subprocess fixture batch also passed all 29
cases, with ordinary process_ext 6/6 and process_run 7/7 tests passing.

[All exact result lines](2026-10-12-ai-ops-test-results.md), including every native
case, are recorded separately. `git diff --check` and code-map coverage passed.
Production source is frozen; no further implementation or verification remains.
All root/subagent sessions are finished and no commits were made.
