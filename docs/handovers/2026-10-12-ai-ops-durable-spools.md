# Durable CLI output custody review handover

Repo `/var/tmp/te-wt2/hops`, branch `feat/ai-ops-auto-settle`, base `7ec0a12e`.
All implementation and this document remain **uncommitted**, as requested.
This is a local evidence handover; no issue update or publication was performed.

The contract is original paid-output conservation, no Unknown replay, nonblocking
explicit removal/upgrade, durable quota, and job delivery without a reload. Root
owns integration and final suite results. This agent owned host-spool custody,
backend process-output integration, lifecycle spool cleanup, and finding 7's
delivery assertions.

## Finding 1 and final architecture

The fail-first native trace was completed original stdout in the broker spool
→ compatible upgrade → quiesce stage callback refused by the drain fence
→ broker retirement deleted the sole output. Raw logs:
`/tmp/hops-spool-before.log` (red), `/tmp/hops-spool-after.log` (green).

SDK 3 process replies now live in `service_state/host_spools.rs`, with an opaque
handle, exact original generation/request ID, bounded reservation, optional
consumer/operation binding, and a complete manifest containing exit status,
lengths and hashes. File/manifest/directory sync precedes durable completion.
The writer pin is acquired before advertising a reservation and outlives broker
retirement. Completed bytes survive lost replies and compatible replacements;
explicit release uses unlink plus directory barriers before removing accounting.
Original identities remain immutable. Recovery never executes another CLI.

Important production seams:

- `installed_plugins/backend.rs:335`: `ProcessSpool::complete`; local writer
  lifetime, preservation after pending-marker failure, durable sealing.
- `backend.rs:1591`: `host.process.recover`, explicit original owner or original
  provider resolved from a durable admission. Ambiguous unqualified IDs reject.
- `backend.rs:1752`: validate optional process custody before paid dispatch.
- `service_state/host_spools.rs:587`: atomic pinned reservation;
  `:623` operation binding; `:658` exact-owner unbound discovery;
  `:680` bound discovery; `:866` completion-evidence classification;
  `:882` result lookup; `:963` collection; `:1025` sweep.
- `installed_plugins/lifecycle.rs:433,460`: incompatible replacement and removal
  collect each affected operation's bound spools, including provider-owned
  spools for a removed consumer. Package-wide cleanup covers explicit removal.

## Additional defects verified while implementing custody

These are **targeted sequences**, not proptest-shrunk counterexamples. Model
shrinks are recorded separately in
`2026-10-12-ai-ops-reference-model.md`. Several defects below were exposed in
the new custody implementation and fixed during review; they should not be
misrepresented as all having existed on the original branch.

| Defect | Minimal targeted fail-first trace | Evidence and final seam |
| --- | --- | --- |
| Pending metadata failure discards complete paid stdout | Complete CLI → next durable transaction fails → `complete` returns before writing bytes → drop/retire/reopen → no result | Red excerpt: `/tmp/hops-spool-targeted-red-excerpts.log`, session 6564. Green excerpt: `/tmp/hops-spool-targeted-green-excerpts.log`. Production `backend.rs:335`; test `paid_stdout_survives_failed_pending_marker_commit_and_retirement`. Marker failure now defers metadata and still publishes bytes/manifest; explicit cancellation still refuses. |
| Missing-manifest classification leaks an abandoned reservation | Reserve spool → directory cleanup deferred → no writer and no manifest → sweep while provider remains live → 1024-byte charge remains | Red excerpt session 93241; green excerpt session 57682, paths above. Missing manifest is `AppError::NotFound`, not `Io(NotFound)`. Sweep now collects provably incomplete unpinned reservations even for a live provider. Test `abandoned_reservation_is_collected_even_while_its_provider_remains_alive`. |
| Raw process success overrides authoritative provider failure | Exit-zero raw reply → provider publishes Failed because it contains no valid image → both workers idle → raw reply wrongly prevents settlement | Red excerpt session 48229; green excerpt session 57682. `has_bound_host_output_at` ignores provider Failed/Cancelled; settling releases bound raw bytes. Test `provider_rejected_host_reply_cannot_pin_inactive_failed_or_cancelled_work` covers both valid terminal receipts. |
| Visible completion bypasses a failed durability barrier | Write bytes/manifest → spool-directory sync fails → sweep sees complete manifest → lowers charge from 1024 to 10 without retrying sync | Red excerpt session 93633; green excerpt session 36970. `sync_complete_host_spool` at `:557` runs before recovery result (`:922`) or successful sweep repair (`:1054`). Test `visible_completion_cannot_publish_recovery_or_lower_quota_before_directory_retry`. |
| Unreadability becomes false evidence of absence | Complete bound exit-zero reply → chmod stdout to 000 → Unknown/idle → `.ok().flatten()` says no output; an unbound lost-seal row can then be collected | Red excerpt session 15112; green excerpt session 36970. `spool_bytes` preserves Permission/IO errors at `:516`; `completion_evidence` distinguishes proven missing/corrupt from transient storage failures. Discovery propagates storage failures; sweep defers collection. Test `unreadable_complete_host_output_defers_settlement_and_collection` restores access and verifies the original bytes/charge. |
| Legacy unbound success disappears behind dismissal | Complete unbound reply → provider Unknown → six unhealthy sweeps exhaust status budget → operation settles/dismisses → provider becomes healthy → no candidate remains | Raw red `/tmp/hops-unbound-spool-before.log`; raw green `/tmp/hops-unbound-spool-after.log`. `has_unbound_host_output` keeps exact-owner result discovery alive; root's `Store::auto_settlement_operations` and `LiveAutomatic` retain probing while execution/input capacity can settle. Native test `native_review_unbound_host_success_delivers_after_exhausted_status_outage_without_restart` delivers the journal-correlated original PNG without upgrade, reopen or `.start`. |

Red/green excerpt files explicitly identify captured tool output; they are not
full raw cargo logs. Native logs above contain complete runner output.

Additional verified review protections, with green regressions but no retained
standalone pre-fix failing build:

- Reused request IDs across incarnations previously selected the newest ledger
  row. Exact original-owner lookup now rejects ambiguity. Unit test
  `repeated_request_ids_require_the_original_owner_instead_of_returning_newer_bytes`
  and the native provider-upgrade collision fixture assert original bytes.
- Retaining the writer pin in the broker map after a publication error could
  block same-session recovery. `ProcessSpool::complete` now takes the pin into a
  local RAII value, dropping it on every exit. Durable bytes remain retained.
- Missing/truncated host bytes and nonzero CLI exits do not protect inactive
  Unknown work. Tests `truncated_or_missing_host_bytes_cannot_pin_an_inactive_unknown_operation`
  and `unsuccessful_bound_cli_is_not_a_success_witness` verify settlement and
  released quota. Consumer-scoped cleanup preserves other consumers' originals.
- Reserving before pinning admitted a sweep race. Production reserves with the
  pin already held; no reserved-row publication/path creation gap remains.

## Finding 7 and validation

The old matrix was renamed to describe custody/authority preservation accurately.
`compatible_upgrade_recovers_or_settles_every_original_phase_without_new_paid_work`
at `mutation_matrix_tests.rs:682` drives production automatic reconciliation and
real Store read/copy/acquire/ack/complete across both roles and all 11 phases.
It asserts original image pixels, Completed/acquired, immutable authority, empty
claims, and actual recovery execution. Prepared/discarded cases settle instead.
Native fixtures additionally exercise actual `LiveAutomatic`, replacement
brokers and reverse IPC, detecting a no-op production recovery implementation.

Recorded results:

```text
spool batch: ok. 15 passed; 0 failed; 2 ignored; 2259 filtered; 0.12s
host_spools final: ok. 15 passed; 0 failed; 2266 filtered; 0.16s
all-phase delivery matrix: ok. 1 passed; 0 failed; 2275 filtered; 1.36s
legacy unbound native red: FAILED. 0 passed; 1 failed; 2277 filtered; 0.73s
legacy unbound native green: ok. 1 passed; 0 failed; 2281 filtered; 0.51s
```

Reproduce the focused contracts:

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --manifest-path src-tauri/Cargo.toml --lib host_spools -- --nocapture
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --manifest-path src-tauri/Cargo.toml --lib compatible_upgrade_recovers_or_settles_every_original_phase_without_new_paid_work -- --nocapture
sh /tmp/hops-run-native.sh installed_plugins::service_bridge::native_tests::native_review_unbound_host_success_delivers_after_exhausted_status_outage_without_restart /tmp/hops-unbound-spool-rerun.log
```

The native runner provides private Xvfb/Openbox, isolated D-Bus/XDG roots and
verifies inherited DISPLAY. Never use the active desktop. No process from this
agent remains running. Root owns final twice-parallel Rust, deep-model, full
native recovery and affected Vitest results; read its final logs before claiming
whole-suite completion.

Independent read-only review of the frontend agent's final timeout bookkeeping
fix (`ai_operations.rs:589`) is **CONFIRMED**: a sent failed answer is counted
before expired-deadline metadata reads; a fresh fourth pass obtains a fresh idle
proof without issuing a fourth status RPC. Pre-RPC or explicit `storage_full`
exempts uncertainty counting and short-circuits the metadata lookup; dynamic
backpressure also defers settlement. Successful reconciliation clears counts.
Its fail-first native log is `/tmp/hops-native-timeout-diag.log`; final green
runner evidence belongs to that agent/root. No production edits were made during
this independent review.
