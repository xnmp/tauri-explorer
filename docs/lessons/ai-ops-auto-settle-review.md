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

A retained or uncertain operation survives compatible replacement in every
phase, including execution-released Accepted/Running and acquired Released
admissions. Negotiate using
the manifest's existing service dependency identity and major, and retain the
original caller identity for provider RPC and artifact custody. Apply this rule
to job status, resume, cancellation, and completion events too. Native job
registration alone is not an active worker. AI admissions, claims, jobs and
live calls never veto a lifecycle change; checkpointing is best effort before
native retirement. The same phase-independent contract predicate controls both
replacement retention and recovery authority. Clear previous probe budgets and
presentation dismissal markers after repair, preserving the no-replay fence.

Explicit provider or consumer disable/uninstall releases every affected
operation, input, output and quota, and terminalizes every nonterminal job.
Undelivered success publishes at most one ordinary Failed notice naming the
removed plugin. A durable removal intent precedes cancellation and the package
index write; startup completes it even when the index still shows enabled.
Incompatible replacement uses the same custody transaction. Transactional
generation retirement rejects delayed capture, job registration and admission;
call/startup revision fencing rejects requests that resume after re-enable.
Counterpart cancellation queue rejection leaves a durable retry. A late-success operation previously settled Unknown
can change from Discarded to that delivery-loss report in the frontend reducer.
Automatic settlement never uses the explicit-removal path.

Settling inactive no-output work retires captured input custody in the
settlement transaction. Artifact rows retain their quota charge until the
collector actually deletes the files. GC collects those inputs independently of the
operation's forensic admission and output reservation, which remain available
for original-output recovery and Unknown no-replay enforcement.
Run the same collector used on open immediately after the settlement commit.

An acquired output can outlive its Running presentation job if the consumer
crashes before completion. Verify the acquired copy's path, length and hash,
then publish completion directly from durable evidence; a run ID is optional.
Discovery must enumerate admissions rather than claims, which omit Released
and execution-released rows.

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
A restart can erase an uncommitted session witness after an upgrade; compatible
unpaid provider recovery covers every phase while its start fence stays intact.
Explicit provider removal or incompatible replacement disables transitive required dependents in one
index commit. Optional
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

Validated sealed output is durable custody evidence even when the provider success
publisher never reaches the host. Complete valid original stages also keep automatic
recovery eligible. Check retained custody in the settlement transaction, override
old matching dismissal markers during discovery, and keep querying unpaid status
beyond the uncertainty budget while original output exists. The native outage
regression fails six status probes and then completes delivery from a healthy
status without a restart, upgrade, or new execution.

Output reservation revalidates the current admission, pinned provider authority,
and artifact status in its own transaction. Earlier validation does not authorize
a callback that resumes after removal. A normal IO lease retries collection when
it drops; collector leases suppress recursive collection. Removed artifact rows
are durable pending-collection records and remain quota-visible until deletion.
The existing automatic worker retries these rows every sweep, independently of
recovery candidates. Enumerate pending artifacts directly, rather than visiting
every historical released operation, so forensic tombstones cannot consume the
recovery deadline. This applies to input settlement and every removal path.

Presentation pruning must evict excess terminal history before enforcing the
total bound. Exactly 128 active plus 256 terminal rows is valid input to explicit
removal; one synthetic delivery-loss report can temporarily create row 385 in
the same transaction. Incompatible native upgrades now assert Released/discarded
custody, one failed notice, deleted bytes, and durable reopening. Compatible
consumer and provider replacements run separately and assert the recovered
file hash, acquired receipt, Completed job, and absence of another start.

## Shrinking reference-model review, 2026-10-12

Example matrices missed interleavings between recovery IO, lifecycle mutation,
and physical accounting. A hand-written Proptest reference state machine now
drives the real Store, service bridge, automatic worker and lifecycle code. Its
oracle keeps paid outcomes and original bytes independent of provider receipts.
Shrunk production counterexamples are persisted and have deterministic tests:

- Admission → sweep → original stage write: a lease-drop collector deleted the
  stage while an unpaid original writer still held its permit. Recovery ownership
  is shared across handles of the canonical ledger root; reopening and collection
  preserve that writer's full reservation.
- Admission → sweep → directory-sync failure → incompatible consumer upgrade:
  physical cleanup failure blocked Store opening and therefore explicit mutation.
  Defer cleanup with its conservative charge instead of making it an admission
  gate.
- Admission → valid stage, provider still Unknown: the scheduler only selected
  recovery for Succeeded receipts. Valid retained originals independently require
  unpaid recovery, even if success publication was lost.
- Admission → sweep → compatible consumer upgrade → directory-sync failure →
  healthy cached Running status: publication revoked the durable idle/no-replay
  capacity fence. Only new original success can restore custody; cached work
  statuses cannot resurrect execution.

Retained output means decoded complete PNG bytes with matching pinned length/hash,
or a complete validated host CLI reply. A truncated stage, missing sealed copy,
failed CLI reply, or provider-rejected reply cannot indefinitely pin inactive
Unknown/Failed/Cancelled work. Missing succeeded originals preserve the success
and original identity but release input/execution capacity and shrink reservations
to physical copies. Validate source bytes before reserving recovery capacity.

Unlink NotFound is not proof of durability. GC and stage finalization must sync
the parent directory on every retry before shrinking or deleting accounting;
failed barriers retain the prior charge. The power-loss oracle restores unflushed
removals and drops dirty stage writes. Real SQLite FULL-synchronous transactions
remain in use; this does not simulate arbitrary controller or database corruption.

Complete CLI replies have a durable host-spool ledger and synced manifest before
provider staging. Broker retirement releases memory ownership rather than deleting
the sole original. Pin before exposing the writable path, charge reservations and
physical bytes, repair manifest-before-ledger completion, retain unreadable replies
as unavailable IO rather than absence, and scope recovery by original generation.
Optional consumer/operation binding supports precise removal; legacy unbound
original-owner replies keep unpaid status discovery eligible without guessing an
operation association.

Lifecycle revisions also belong to service admissions and their capacity counts.
A cancelled lease cannot acquire a new incarnation after disable/re-enable or
occupy replacement capacity indefinitely. It still represents actual worker
ownership until it drops. Completed paid subprocess exit/output wins concurrent
owner cancellation; generic Git cancellation semantics remain separate.
An independently detached descendant can also hold stdout/stderr after the paid
leaf exits. Bounded owned-process draining preserves already captured bytes and
the authoritative exit rather than returning a pipe-timeout error that discards
the sole reply. Raw captured bytes still require the provider's normal image
validation; EOF is not substituted for image validity.

Frontend late completion may legitimately have no run ID. Accept a newer validated
same-identity Completed correction with a delivered path after stopped or delivery
failure, and keep unrelated/stale terminal corrections rejected.

Native timeouts require retry bookkeeping without another deadline-bound store
read first. An expired status RPC can otherwise repeatedly persist its incarnation
while recording zero failed answers, defeating the bounded uncertainty budget.
The next fresh pass still performs actual worker-idle proof before settlement.

## Eighth review: process durability and removal oracles, 2026-10-12

Use `durable_dir::sync_file` for every host-spool file barrier. Windows requires
writable handles for FlushFileBuffers; a read-only verification handle cannot
serve as a portable durability barrier. The shared helper opens writable on all
platforms and its test build checks that mode, while spool tests observe that
both sealing and recovery actually call it. The Windows-specific module also
compiles independently for MSVC when dependency C builds block the full target.

Persist an independently validated completion intent while the spool is still
reserved, then stdout/stderr and their immutable pending identity before
advertising completed-pending. A pending commit independently stores status, lengths and
hashes; recovery validates those bytes and repairs a missing completion manifest.
Legacy status-only pending rows also recover their bounded fsynced reply. A short
pending-manifest write must not hide the authoritative database witness. Tests
also cover metadata flush failure together with a pending transaction failure,
and a partial manifest together with a failed fallback commit.

Settlement and bound-spool release share the admission/job transaction. Physical
unlink remains retryable, quota-visible work discovered directly from the spool
ledger by startup and periodic sweeps. Reconstruct release intent for old-host
crash images whose settlement committed before the former separate release step.
Nonzero unbound replies cannot remain charged after all associated work settles.

Commit explicit custody and the spool reservation in one transaction, before
starting the process. Without custody fields, derive ownership from all nonreleased
admissions for the provider package, including fenced admissions and compatible
digest replacements. A unique admission is recorded; multiple possible admissions
refuse the process before it starts and require explicit custody fields. Consumer
removal releases its bound or uniquely inferred originals while other consumers
sharing the provider retain theirs. Legacy ambiguous metadata cannot establish
which consumer paid for the original; preserve it until its possible owners are
resolved or all release it rather than delete another consumer's sole original.

Operation recovery checks custody before considering the admission's original
provider generation. An early exact-owner return can cross operations when SDK
request counters reset. Conversely, rejecting every multi-owner request makes a
compatible replacement's unrelated singleton-inferred spool block the original.
After custody filtering, prefer the admission's original generation; otherwise
require explicit disambiguation for multiple matching owners. Real reverse-RPC
replacement tests reproduced this latter failure despite green Store/model suites.

Removal notices inspect valid retained raw image replies before release. Transient
read permission failures cannot veto explicit removal when cleanup can unlink the
bytes; retain the conservative possible-delivery-loss notice and complete cleanup.

The model's global charge==disk oracle was insufficient: a removed operation can
leave both equally nonzero. Require per-operation and per-disabled/uninstalled
plugin absence of custody, linked spool charge and raw files after healthy cleanup.
Count actual consumer copy effects and emitted consumer_removed Error events;
job revisions and the existence of one deterministic output path do not count
those effects. Route model recovery through the shared production recover_in and
resume_in paths, with injectable provider/consumer protocol endpoints. Native
isolated tests separately exercise real reverse RPC and lost-manifest recovery.

Split process spool durability into reservation, reply persistence, pending commit,
file sync, manifest publication and seal commit. Crash each boundary. Lifecycle
fault seams preserve intent/index/abandonment/cleanup and upgrade journal phases
for real restart recovery. Pause invoked recovery callbacks, acquisition and real
pinned writers across disable, uninstall and compatible/incompatible replacement;
include delayed lower/equal conflicting receipts, nonzero and unbound replies,
and multiple consumers. Deep runs fail if any of the 80 required families has fewer than
three observed hits, or if acknowledgment-crash never executes. A directed,
precondition-valid campaign supplements randomized shrinking to enforce coverage.

## Ninth review: independent streams and pre-admission custody, 2026-10-12

A completion intent describes each stream independently. Reconstruct a missing
stream only when its recorded length and hash prove empty contents. A damaged
sibling cannot authorize collection of verified stdout, including through automatic
Unknown settlement or removal classification. Full reply recovery still requires
both streams to validate; successful verified stdout separately proves retained
output and, when it is a valid PNG, a possible undelivered image.

Process exit does not mean the reader threads ran. Retire capture by draining the
queued-byte snapshot before closing pipes; use nonblocking reads/PeekNamedPipe so
an escaped pipe holder cannot require future writes or a wall-clock drain deadline.
Always join output readers rather than detaching a thread that still owns unread
original bytes.

Presentation exists before capture and service admission. Compatible lifecycle
retention must therefore include admission=NULL preparations and pre-capture jobs.
Durable replacement authorization covers adoption of those original IDs and input
receipts; job controls must reload presentation after adoption. Interrupted input
capture can retry its original spec only after old IO leases have ended. Startup
must not collect it before pending upgrade-journal reconciliation.

Broker retirement queues death recovery before preflight commits compatibility.
Preparation cleanup must share the lifecycle action lane at its local transaction,
including retry cleanup, while avoiding that lane during provider IO. Reverse IO
callbacks must not create another implicit dead-preparation cleanup path.

Incompatible replacement owns every package spool, including custody-less calls
without admissions. Legacy SDK release must reach durable storage too. Selective
mixed-contract cleanup preserves independently compatible admitted originals.

Crash models need actual creation/write/flush/rename checkpoints. Count native
work and consumer run/delivery effects independently of .start and deterministic
output filenames. Durable acquisition proof can make acknowledgement retry
idempotent; a file's existence cannot establish that protocol identity.
