# Acquisition release cancels a pending bound host spool

A Windows dev-push run of `ai_operations_reference_state_machine` shrank to
`Admit(0) → SpoolReserve(0, bound) → ProviderComplete(0) → Acquire(0) → Sweep`
and failed in `quiesce` with "host output reservation was cancelled". It is
deterministic on every platform; the random generator only rarely draws it.

The trace has two independent replies for one operation. The bound CLI
reservation is pinned by its writer but has not received its reply (model
`spool_phase` 1). The provider then writes and seals the original through its
stage, publishing Succeeded. The consumer acquires that original, and the
sweep's reconciliation releases the admission with disposition `acquired`.

Production is correct. Every admission release ends custody in the release
transaction: `release_operation_spools_in` (`service_state/host_spools.rs`)
marks that operation's bound spools `released`, called from the release path in
`service_state/job_store.rs` (`release_job_custody_in`). A pinned writer that
has not yet recorded its completion identity is then refused at the start of
`write_pinned_host_reply_observed` or at its post-checkpoint-10 identity
commit. Its bytes cannot become a second result for an operation that has
already delivered its original, and its quota is collected once the pin drops.

The reference model was wrong. `quiesce_inner` drove every live writer of a
`paid_success` operation to checkpoint 17 without checking `host_released`. It
assumed the paid success came from that spool. Elsewhere, `spool_phase` already
returns early for host-released operations. A `paid_success` caused by stage
completion does not make an unrelated pending CLI reply part of the
operation's custody.

Fix: quiescence now handles host-released operations separately. A writer that
had not passed the identity commit (`spool_phase <= 11`) must be refused with
the cancellation error. Completing it is a failure ("acquisition release left a
bound host reservation writable"), as is any other error. The paid-success
completion branch is unchanged for operations that are still held. The pinned
regression is `model_acquisition_release_cancels_pending_bound_spool_writer`,
which also asserts that the writer took the refusal path.

When a model and production disagree at quiescence, check which custody
transaction production documents before changing either side. Then check
whether the model's own per-command guards (here `host_released`) apply to its
quiescence shortcut.
