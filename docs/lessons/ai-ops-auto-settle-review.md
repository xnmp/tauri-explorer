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
