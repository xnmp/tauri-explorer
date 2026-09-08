# Native mutation authority must match its evidence

## Batch admission cannot expose a successfully reserved prefix

Replacement promotion consumes one reservation into one durable operation.
Reserving one union cannot supply several independent promotions, while looping
single reservations can expose a prefix before a later conflict is known.

The coordinator now captures ordered child resources under one revision and
commits every child's reservation in one SQLite transaction. Each child has a
distinct native lock and generation. Inter-child write conflicts are rejected
before allocation; shared reads remain compatible. Aggregate count/encoded-byte
limits cover all child claims and aliases rather than resetting per child.

Generation exhaustion can occur after native owner files have been created.
The transaction returns no admitted children, their live handles close, and a
later healthy admission reclaims their unreferenced names. Tests force that exact
path and verify no user effects, unchanged revision and subsequent cleanup.
Other tests independently promote two children, finish an ordinary sibling while
preserving a promoted one, and exit a real process without Rust destructors before
reclaiming its unpromoted children.

This primitive is for independent children. Ordered overlapping copy targets,
conflict decisions, exact ordinary-copy inverses and a whole-batch outcome ledger
still belong to the next planning/execution layer; atomic reservation is not
atomic filesystem execution.

## Completion warnings must not stop dependent history work

A successfully restored replacement can fail to publish its recovery inventory.
Treating that diagnostic as an execution error stopped the next batch action even
though the replacement completed. History execution now carries warnings separately
from failures. Batches preserve first-occurrence warning order, continue after
warnings, and stop only at real execution failures. Retention and missing-opposite
diagnostics follow the same contract. The warning accumulator limits UTF-8 content
to 16 KiB and 32 messages including an omission marker; those content limits do not
describe allocator capacity or escaped JSON size.

The replacement-warning/rename regression failed before the separation. Mixed
nested failures verify that completed effects, remaining work and inverse receipts
still partition correctly. Frontend regressions verify successful completion and
Redo survive warning-only replies, while mixed replies retain their actual error.

## Mutation reconciliation needs a deadline that watcher churn cannot move

Real detached Undo acceptance exposed a surviving listing waiting behind the
ordinary two-second watcher interval. Native publication now retains mutation
origin through pending-event merging and emits it without the watcher quiet
period. The existing refresh manager owns prompt reconciliation: it anchors a
150ms coalescing deadline at the first mutation request, waits for any in-flight
listing, and bypasses the adaptive watcher interval. Native maintenance and IPC
can still delay delivery; the 100ms polling interval is not a latency guarantee.

Simply preserving mutation priority was insufficient: resetting the shared
trailing-debounce timestamp on later watcher requests allowed continuous traffic
to postpone the mutation indefinitely. Two failing-before fake-clock regressions
and independent review exposed that defect. The first-mutation deadline is now
separate from ordinary watcher debounce. Navigation guards and per-subscriber
observation-time checks remain in their existing owners.

Native tests must distinguish publication from notify delivery. The held-listing
probe had bypassed the canonical mutation API and broke when write commands gained
renderer-session ownership. It now writes through that API and requires a fresh
mutation-origin receipt. These receipts can coalesce notify and application
publication; requiring a separate watcher-only
event can wait forever because that event was already merged. This case proves
coalescing of native app mutations during a held listing. The separate adaptive
cadence case uses external host writes to exercise notify-only delivery. Every
acknowledgement still needs a backend observation time at or after its write began.

## Completed recovery records must release public paths

Keeping every immutable intent in the conflict index forever prevented ordinary
edits after successful copy publication or restoration. Deleting the record to
release those paths would also lose retained originals and recovery authority.

Reservation admission and recovery now share one effective-claim projection.
Only error-free Published/Restored checkpoints with a verified idle native owner
can release public paths. The retained root and payload keep both namespace and
physical-object protection. Active, transitional and uncertain operations retain
full claims, and explicit recovery checks those full claims again before taking
effect authority. A later replacement can therefore prevent an earlier restore
until the later retained original returns to its public destination.

Idle owner probes close inside the persistent admission gate, which all effect
acquisition paths take. A subprocess regression positively observes that gate
busy while the idle owner is already available; it does not infer exclusion from
a timeout. This keeps probe descriptor use constant across the bounded catalog.
The effective-claims test modules exercise actual coordinator/executor behavior,
including hardlink and relocated-root aliases, damaged evidence and successive
restoration. Retention quotas and artifact retirement remain separate work.

## Move history uses one path authority

While extracting the owned inverse plan for #680, a native regression showed that
an admitted Move could carry inconsistent `source_path` and `original_dir` fields.
Undo moved the actual file to `original_dir`, while refresh derived affected
parents from `source_path` and `dest_path`. The UI could miss the changed directory,
and the inverse could move data into an unrelated directory.

The inverse now derives its original parent from `source_path`, matching the
existing refresh contract. `original_dir` remains serialized legacy metadata;
it no longer determines the filesystem request. The existing landed-basename
semantics are preserved. The browser fixture follows the native path rule.

`move_history_uses_recorded_source_parent_despite_inconsistent_legacy_metadata`
in `src-tauri/test_support/file_history_uncertainty.rs` exercises renderer
admission and real native Undo/Redo with exact bytes. It fails before the fix,
then passes while leaving the unrelated directory's sentinel untouched.
Nested invalid-plan tests separately preserve partial progress and original
history ordering in both directions; planning must not fail a whole batch before
its execution-order predecessors have run.

## Retained storage handles can outlive their directory entries

A retained Unix directory handle still supplies valid metadata after the empty
directory is removed. Checking only directory kind, owner and mode therefore
accepted already-retired storage. Opening a handle is not proof that its namespace
entry is still live.

The shared recovery validator now also rejects a directory with zero links. It
does not demand the conventional directory link count of two: live filesystems
can report one. Windows checks delete-pending state through the retained handle.
These remain point-in-time observations; named-root verification and admission
still establish the separate namespace and concurrency contracts.

`retired_directory_is_not_valid_private_storage` in
`src-tauri/test_support/recovery_private_storage.rs` fails before the Unix fix
and passes afterwards. It removes the real directory while retaining its handle;
it does not fabricate metadata or test a copy of the validator.

## Missing destinations still have physical namespace ownership

Linux canonicalization preserves bind-mount spellings. Two missing destinations
under aliases of the same directory therefore have different canonical paths and
no leaf object IDs, yet name the same prospective entry. The earlier conflict
index incorrectly allowed those writers to proceed together.

Index the remaining relative suffix under every captured existing ancestor ID.
Using only the nearest ancestor misses a competing capture after a previously
missing intermediate directory becomes real. Keep suffixes component-based so
siblings remain independent, and preserve read/read sharing and final symlink
ownership. `real_bind_mount_aliases_preserve_missing_destination_ownership` tests
actual Linux bind aliases in an explicitly private user/mount namespace; it is
opt-in and does not alter the host mount namespace.

Deep batch inputs exposed expensive repeated `Path` comparisons. Shared
NUL-delimited component encodings preserve native byte names and component
boundaries while avoiding that reparsing. The mixed-name contract test compares
index outcomes with a direct path-overlap oracle, including non-UTF8 names,
normalized separators and varied subtree insertion order. Release benchmark
results and their memory cost are recorded separately in
[resource-index evidence](../reviews/recovery-resource-index-2026-09-08.json).
This Unix encoding does not establish Windows or case-insensitive macOS name
semantics.

## Admission and execution must use the same resolved paths

The first Linux entry integration admitted canonical parent paths but executed the
original alias spelling. A managed alias replacement could redirect a previously
admitted write into a different directory. The regression fails before binding,
then covers all five entry request kinds with real filesystem changes.

Reservations now retain their primary captured paths in request order. The owned
entry plan binds those paths before dispatch; rename history records the bound
path. Alias display spelling is retained only while it denotes the committed
parent, and both parents are refreshed. Additional read claims protect every
traversed parent symlink, including aliases hidden inside another link target.
This preserves literal symlink text and fences managed alias replacement through
publication. External alias substitution cannot redirect the bound worker.

Independent cold Runtime instances also reproduced a gate-creation race: a failed
initial open followed by a nonempty directory observation was classified as lost
evidence, even when the other initializer had just created the valid gate. Open
that observed gate again; never create a replacement in populated storage whose
gate is actually missing. The native regression races independent instances and
verifies that neither successful owner loses its claim.

## Trash preparation includes its auxiliary namespaces

Source-only ownership cannot describe Linux trash. The operation also creates or
repairs layout directories, stages metadata, publishes a `.trashinfo` entry and
moves a payload. Select exact names and directory actions through read-only
preparation, then execute those actions. A late collision must preserve the
occupant rather than allocate a name outside the plan. The Freedesktop
[fallback requirement](https://specifications.freedesktop.org/trash/latest/)
means the personal alternative must also be prepared when shared trash is usable;
simply dropping fallback would regress the platform contract.

Two independently prepared first-use deletions exposed an `AlreadyExists` race
at layout creation. A planned creation may reuse an appeared real, private,
same-user directory after no-follow opening and validation. It must not repair
its permissions: only an explicit repair step may do that. Previously captured
directory objects remain identity-checked, including their mount IDs. Directory
ctime is unsuitable because ordinary sibling writes change it.

The self-containing-destination regression rejects trashing a directory whose
configured trash root is inside that directory, before creating any layout.
Whole-selection physical overlap, batch admission and durable cleanup evidence
remain separate integration requirements; these preparation checks do not prove
complete recovery coverage.

## Hardlinks require rename-stable payload versions

Real filesystem regressions showed that deleting a second hardlink invalidated
Undo for the first, and that executing a prepared sibling invalidated another
plan. Linux [inode timestamps](https://man7.org/linux/man-pages/man7/inode.7.html)
include changes to link metadata in ctime. Use a shared bounded version of the
object, size, mtime, kind, mode and ownership. Exclude ctime and nlink from payload
versions while retaining strict ctime plus digest checks for immutable trash info.

Compare the full version after both successful and error-returning renames, not
just the object ID: a retained inode can be edited during the operation. The
regression injects a payload edit into both outcomes and verifies uncertainty plus
preserved evidence. Independent preparation and Undo cover both hardlink orders;
write/chmod and directory-child changes still reject through the real executor.
Versions are ordinary-change detectors, not hashes or recursive snapshots; coarse
or restored timestamps, extended metadata, nested writes and native races remain
explicit limitations.

## Source observation precedes destination planning

Per-item trash preparation allowed an aliased duplicate or aliased ancestor to
reach effects before the second item failed. Whole-selection preparation must
observe requested sources first, including nested parent symlinks used to reach
them. A reproduced nested-link case otherwise deleted an alias still needed by
another requested source's history path.

Independent review found that indexing only successful destination plans still
lost an existing ancestor when its candidate allocation failed. The regression
preoccupies only that ancestor's deterministic candidate: selection must reject
its physical overlap with a child before either moves. Index all requested source
namespaces before entropy/layout work, then retain ordinary destination failures
as aligned outcomes. Use full-value sharing for layouts and dependencies; never
deduplicate exclusive artifact names into permission to overwrite the first.

Request keys are the batch ledger's shared immutable vector; native execution
paths are separately captured. This avoids a second large string copy and avoids
re-deduplicating resolved paths into a different receipt cardinality. Expanded
claims and retained plan bytes have separate bounds; an input-count cap alone
cannot bound a file operation's complete auxiliary namespace.


## Recovery demand belongs to the page lifetime

A lazy recovery import can resolve after its page has gone away. Create an
inactive store per page, check disposal before adopting/starting it, and share the
pending acquisition across concurrent foreground/user demand. Repeated disposal
must return the same pending teardown promise; returning a fresh resolved promise
lets a second caller observe retirement before the late registration is released.
The regression holds registration through two disposal calls and acknowledges it
only after verifying both callers still await cleanup.

Keep failed initial navigation separate from successful-startup telemetry: the
error shell still needs recovery, but must not emit a successful ui-ready marker.
Parked windows must wait for committed activation before background recovery.
An optional status bar cannot be the sole proactive surface for recovery attention.

Disabling or removing a focused action button can drop focus to the document body,
outside an overlay-local keyboard trap. Park focus on a stable modal control before
accepting the asynchronous action; restore a surviving row control only if the same
modal/focus still belongs to that request. Browser tests must assert the exact
surviving control, and close/reopen during a held action to challenge stale focus.

Production bundle builds and Svelte checks regenerate .svelte-kit files watched
by the dev server. Finish those before browser acceptance: concurrent regeneration
caused a real page reload that detached the recovery dialog during a test click.

Native recovery presentation must identify the artifact container, not always
`root/original`: restoration moves that entry home and retains the copied bytes
as `root/publication`. The real dialog/IPC test and a service regression reproduced
the stale displayed location after restoration.

For native channel-retirement evidence, JavaScript callback IDs are not global
identities across windows or reloads. Assign a native registration ID, associate
it with the exact window/session/client token, and record after the actual Tauri
Channel is dropped. Missing callbacks from a dead renderer do not establish native
cleanup. Keep IPC serialization in the command adapter and typed snapshot delivery
in the runtime. Decode DOM JSON envelopes outside WebDriver: returning an object
with an `error` property can be interpreted as a WebDriver protocol error.

## An overwritten file needs a different inverse from an ordinary copy

The old transfer/paste/drop history path recorded every successful copy as a
path-only Copy action. Its inverse removed the copied destination; it could not
restore an overwritten original. Production durable replacement receipts now
identify their native recovery record. Those receipts must never join ordinary
Copy history, including mixed batches. Until native replacement history is
implemented, the operation remains committed and the caller shows its explicit
Undo limitation. The recovery dialog provides restoration without pretending the
ordinary inverse is valid. Four failing-before frontend contracts cover the
single-transfer and batch inverses and an uncertain cancellation error that the
old substring predicate silently classified as a clean cancellation.

## Presentation paths are insufficient for native cache publication

An overwrite through a symlink alias succeeded against its captured physical
parent, but history only published the caller's alias. Directory-cache keys are
exact strings, so a separate physical-path pane retained pre-copy metadata.
A real listing-cache regression returned the old 14-byte size after the copied
12-byte file had already been published.

Prepared replacement ownership now retains its physical refresh projection before
execution starts. The worker publishes that distinct parent through the existing
watcher/cache seam after completion or unwinding; history settlement publishes the
requested spelling. No extra same-path event is needed. Keep presentation rewriting
separate from effect identity, and retain refresh authority across failures and
lost IPC replies, not only in successful serialized metadata.

## Prepare independent replacements before consuming their owners

A loop around singleton preparation is not batch preparation: each replacement
consumes its reservation at promotion, and later metadata/identity errors can be
found only after earlier file effects. Build exact draft roots first, atomically
reserve all independent children, then bind and validate every durable intent
before returning any executable child. Validate again at promotion; preflight is
not durable evidence and does not exclude external filesystem changes.

Queued cancellation also belongs before promotion. A regression cancelled an
already prepared replacement and found a durable recovery item despite no copy
being required. Execution now checks cancellation at entry and explicitly retires
unstarted ownership. The staging/displacement cancellation policy is unchanged:
post-promotion interruption is recoverable and publication finishes once the
original is displaced. Attempt every sibling retirement after a preparation error;
a failed first cleanup must not strand healthy later owners. Report cleanup
failure alongside the primary error without claiming user-file effects.

## Retain receipts outside every child and publication unwind boundary

Preparing the whole group does not preserve a completed prefix by itself. Keep
ordered receipt slots outside the child unwind boundary and complete each slot
immediately after its filesystem receipt returns. Keep the pending queue outside
that boundary too, so a later panic can retire its untouched suffix rather than
abandon every sibling. The failed active child remains uncertainty; cleanup
warnings must not erase earlier exact inverses or change failure classification.

Inventory callbacks run after copying but before the native reply. Their errors
and panics must be contained independently of execution, preserving confirmed
receipts and reporting the discovery problem as a warning. Real grouped tests
exercise both returned errors and panics, then restore both retained originals.
Shared bounded diagnostics must budget the separators added by their consumers:
a joined-output regression showed that bounded message bytes alone could exceed
the 16-KiB output limit by a newline. Reserve separator space before accepting text.

## Report results before destroying the worker context

A successful filesystem return can still disappear if an owned worker context
panics during destruction. A failing-before regression demonstrated this loss.
Publish the returned value into supervisor-owned storage before dropping effectful
resources, then wait for cleanup before settling history. Keep cleanup warnings
independent of successful receipts, including ordinary receipts without replacement
metadata. A real replacement test verifies the preserved inverse restores bytes.

Catch work and cleanup separately: allowing a work panic to unwind through a
panicking context destructor can abort the process. The regression runs that
combination in a subprocess. A separate held-cleanup test verifies that cancelling
the async waiter cannot shorten the blocking context lifetime. Neither test proves
pre-return partial receipt retention; grouped work needs its own outer item ledger.

## Copy inverses follow native publication keys and fresh restore observations

An ordinary path-only Copy inverse can trash a later replacement at the same
pathname. Capture the staged object's version and opened destination-parent
identity before publication, then carry that observation into the actual trash
preparation/execution contract. Disabling the verified request route reproduces
the wrong-object deletion in a real copy/Undo subprocess fixture.

Keep the history key aligned with the physical effect. A receipt may preserve the
user's symlink alias while native trash reports its resolved path. Construct native
history from the publication path so successful trash cannot be misclassified as
failure. Directory::open rejects symlink ancestors, so creating staging under the
resolved parent is necessary before using its descriptor-based publication path.

Redo cannot blindly retain the previous publication. It may recreate a removed
destination directory, giving the restored entry a new parent identity. Return
the fresh observation from restore, preserve it through the bounded batch ledger,
and install it in the opposite action. A second failing-before regression keeps
the stale parent after Redo and demonstrates the resulting unusable Undo.


## Own interactive copies as ordered native sessions

Inspect each child after the preceding outcome: a repeated source can create its
own next conflict. Bind prompt metadata and execution to the same native observation;
real failing-before tests demonstrate that checking only the pathname publishes
unreviewed source/target substitutions. Cancel and Skip need distinct typed outcomes:
Cancel retires the untouched suffix, while completed receipts remain undoable.

Install the native pending reply before emitting the prompt. The renderer must free
its active prompt slot before awaiting resolution IPC; otherwise the next native
prompt can arrive before the acknowledgement and deadlock. Remember pre-Ready aborts
and deliver them when native registration is established. Fence replies by request,
owner, item and a non-reused nonce, and detach retired callbacks independently.

Delivering entry metadata incrementally removes unnecessary final duplicate updates,
but requires the paste context to accumulate its own selected paths. Retain the
existing selection revision check so later user selection and navigation always win.
Keep request-local progress and cancellation ownership separate from presentation.
Avoid a recursive byte-count prewalk before copying a directory, and distinguish
buffered ordinary writes from the durability barriers required by recovery journals.


## Native move admission must govern the worker's actual paths

A recovery catalog does not protect files if a mutation command bypasses it. Two
failing-before real-filesystem tests held source-only and target-only reservations,
yet the old move command still succeeded. Forward moves and the history adapter
now share an owned plan and execution seam that rejects both conflicts before effects.

Use admission's resolved paths inside the worker; do not recanonicalize the original
alias to decide where to move. A deterministic alias-retarget test moves only within
the admitted physical namespace and retains its claim until explicit settlement.
Keep filesystem operations out of the pure plan. Return physical refresh parents and
cleanup warnings to the existing outer supervisor so warning-only completion retains
its opposite and does not publish a second, private refresh flow.

This contract is managed-operation exclusion and path binding. It does not establish
exact leaf identity, crash durability, overwrite Undo or safe path-only Move history.
Those need native relocation authority rather than additional frontend flags.

## Release boundary: retained recovery records need a lifecycle

Unconditional durable overwrite copies retained one journal record per successful
copy. With no supported retirement action, the shared 1,024-record cap eventually
rejected unrelated admitted operations. A real native-session regression reached
the failure on the 1,025th overwrite when the old policy was restored, then passed
1,025 overwrites with the release policy.

Until #687 implements retirement, `durable-copy-recovery` is opt-in. Default
overwrites keep short-lived native claims and staged publication, including exact
publication receipts for grouped Undo. Recovery discovery/restoration must remain
available for already-created journals. Gating new record creation is not a
cleanup or migration mechanism for an already-full experimental profile.

The policy shares staging and observation validation with ordinary copy; it must
not bypass a competing retained operation or replace a reviewed conflict with
newly observed bytes. Cleanup failure after a confirmed publication is a warning
attached to the successful receipt, not a retryable failed copy.

An unrelated worker regression test raced `JoinHandle::abort()` against releasing
the blocking cleanup barrier. Await cancellation acknowledgement before releasing
that barrier so completion cannot legitimately win the test's intended abort
scenario. The blocking worker must still complete cleanup independently.

The full suite also intermittently rejected strict directory-watch acquisition in
the streaming-search integration fixture. Isolation and a diagnostic full run
passed. The fixture had watched roots directly under shared `/tmp`; direct native
observation also watches the parent. Use a private parent and precreate the roots
so this cache-contract test does not depend on unrelated tempfile traffic or its
own queued root-creation events. Diagnostics did not establish overflow or a
production watcher defect; keep that uncertainty separate from the fixture fix.


## Keep platform qualification separate from production admission

A full Windows cross-check with the real MinGW dependencies exposed two release
CI failures hidden by the Linux checks: the WebView initialization plugin needed
an explicit unit configuration type, and unadmitted recovery infrastructure was
compiled into Windows production despite having no callers. All-target Clippy
also caught Unix-only test imports and helpers.

Keep portable IPC/history contracts in `recovery/model.rs` and Unix executor
journal authority in `recovery/durable_model.rs`. Retain Windows identity,
directory, private-storage, file-lock, path-codec and journal adapters under tests
until production admission is qualified. Linux copy observations cannot be
constructed on other platforms; shared dispatch accepts `None` there. Do not
hide these boundaries with blanket dead-code suppression. Cross-compilation
checks source and test reachability, but cannot establish native durability,
Windows filesystem behavior, or macOS startup latency.
