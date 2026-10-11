# Automatic AI settlement must reconcile custody before releasing claims

A broker's absence after a host restart proves that its old worker is inactive.
It does not prove that the provider has no paid result. The automatic settlement
worker can win scheduling before startup recovery starts the provider, so cached
Running, Accepted, or Unknown evidence must first receive an unpaid status query.
A missing package or three failed activation/status attempts can establish that
reconciliation is unavailable; idle proof still remains mandatory. Retry counts
must survive an exhausted RPC deadline, and an exhausted provider must not consume
another full status wait before the settlement transaction. Activation and sent
status failures have separate budgets: an active original provider still receives
a status query, including a newly observed incarnation. Invalid receipts count
as failed answers too. A valid success whose host evidence transaction fails is
latched without exhausting that budget; status queries continue to repair its
evidence, and older/conflicting/non-success answers cannot erase it. Successful
execution always retains output for recovery.

Startup revisits uncertain old dismissal markers without clearing the execution
fence. Provider status recovery may need to stage and seal a raw retained image;
a scoped host output-recovery permit authorizes that original IO through the real
reverse IPC workers without allowing another start or restoring disposed output.

A retained successful consumer handoff may survive replacement. Negotiate using
the manifest's existing service dependency identity and major, and retain the
original caller identity for provider RPC and artifact custody. Apply this rule
to job status, resume, cancellation, and completion events too. Native job
registration alone is not an active worker: the repair drain preserves all
call/process/reverse-work checks, tolerates only the exact successful handoffs,
and still requires the consumer's quiesce/checkpoint handshake.

Explicit consumer disable/uninstall authorizes releasing undelivered output and
publishing an ordinary Failed job. A durable removal intent precedes the package
index write; startup completes it only when the index shows removal/disable,
otherwise retracting it. A late-success operation previously settled Unknown
can change from Discarded to that delivery-loss report in the frontend reducer.
Automatic settlement never uses the explicit-removal path.

Settling inactive no-output work retires captured input custody and charges in
the settlement transaction. GC collects those inputs independently of the
operation's forensic admission and output reservation, which remain available
for original-output recovery and Unknown no-replay enforcement.

Regressions in `service_native_tests.rs` use actual package archives, brokers,
activation, jobs.start ownership, status RPC, reverse artifact IO, upgraded
completion events, malformed answers, evidence repair, provider death, and deadline exhaustion. Lifecycle crash
boundaries and non-empty input quota reuse run against the production store and
mutation entry points. Native fixtures require private Xvfb/D-Bus/XDG profiles.

The success witness must be retained before `BEGIN IMMEDIATE`, not only inside
its transaction. A write-lock timeout can precede the transaction body. Share
that witness across handles of the same ledger, include it despite a prior
settlement marker, and keep failed available/unavailable publication in the
existing recovery loop. Validate its original artifact identity before latching;
invalid acquired/discarded proof must not poison a corrected receipt at the same
revision. Commit successful receipt and terminal custody projection together.

Provider repair follows the consumer policy. Compatible replacements use the
original pinned authority for status, reverse stage/seal and acknowledgement.
A restart can erase an uncommitted session witness after an upgrade, so fenced
Unknown also permits compatible unpaid provider recovery; its start fence stays
intact. Explicit provider removal disables transitive required dependents in one
index commit, after all affected packages pass live-work fences. Optional
consumers remain enabled. Release/report share a transaction, including legacy
successful receipt rows whose terminal projection never committed.

Legacy NeedsAttention/stopped presentation can deliver an authoritative success
without re-entering active job capacity. Correct it only after original output
acquisition and a newer consumer completion prove delivery. Storage-full
presentation has the same acknowledged-completion correction in native and live
frontend history.

A recovery permit is authority, not capacity. Stage and seal must reacquire the
normal stage-plus-seal budget with transactional quota admission before writing.
Never inflate reservations when merely observing a success or opening a legacy
ledger. Quota refusal publishes storage-full job state and does not spend the
finite uncertainty budget; existing recovery passes retry after capacity release.
The real-broker regression fills normal reservations, refuses six original raw
image recovery passes, releases one reservation and checks original image bytes
and completed job history without another start.
