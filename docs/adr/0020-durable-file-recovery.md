# ADR 0020: Durable file recovery

Status: Proposed — implementation and crash/platform acceptance outstanding.

Release policy (2026-09-09): creation of new durable replacement-copy records is
opt-in through Cargo's `durable-copy-recovery` feature until retirement exists
(#687). Default builds keep transient admission and staged overwrites. Existing
recovery discovery, restore and history remain available. Executable durable
moves are implemented (#685) behind the independent `durable-move-recovery`
feature, opt-in for the same reason: a parked cross-filesystem source and a
displaced overwrite target are retained bytes with no quota or GC.
The frozen release scope in `docs/review-completion.md` supersedes broader
implementation prerequisites below.

Governs: `src-tauri/src/files/replacement.rs`,
`src-tauri/src/files/publication.rs`, `src-tauri/src/files/file_ops.rs`,
`src-tauri/src/file_history/`, `src-tauri/src/file_mutation.rs`,
`src/lib/state/window-session.ts`.

## Problem

Current replacement ownership preserves a displaced destination when rollback
fails, but its sibling JSON record is not a durable discovery service. Successful
overwrites discard the previous destination. Cross-device moves still copy then
remove the live source, and partial removal can leave the destination holding the
only complete copy. Source parking must not precede recoverable ownership: a
crash after hiding the source would otherwise strand user data.

## Proposed ownership

### Atomic admission of independent batch children

The coordinator now admits a group of independent children in one gated SQLite
transaction. It captures every child's ordered paths and alias dependencies
outside the gate, then checks the whole capture revision before inserting any
child. Each child receives its own owner lock and unique journal generation, so
one replacement can promote while a sibling independently finishes. A later
failure cannot expose a successfully admitted prefix. The existing single-item
reservation uses this same implementation.

This is an admission prerequisite for queued native file operations. The general
queue-then-execute pattern also appears in Windows
[IFileOperation::PerformOperations](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-performoperations),
whose success status alone does not establish that every queued action ran.
Our batch execution must likewise retain explicit partial results.

This primitive permits shared reads and rejects write intersections between
children, including physical aliases and subtree overlap. Within-child validation
is unchanged. Existing repeated-name/overwrite UI semantics still need a higher
level ordered plan; they must not be silently replaced with blanket rejection.
The primitive does not detect unmanaged external changes after capture or provide
whole-batch filesystem atomicity. Native exact-target planning, ordinary-copy
inverse identities, one worker/cancellation owner, partial-result retention and
paste/drop integration remain required.

### Exact independent replacement preparation

`forward_copy/plan.rs` chooses each replacement's private root once, then submits
all source/target/root request groups to atomic admission. It binds every child's
source version, original version and native destination-parent identity against
that child's captured paths before returning any executable child. Pure preflight
uses the same durable record validation and encoded local-manifest budget as
promotion; promotion repeats validation under admission. Preparation creates no
catalog intent, private artifact root or user-file effect. A preparation error
explicitly retires all children, even when one retirement fails; cleanup diagnostics
preserve the primary error and bound the reported cleanup detail.

Single-copy production preparation delegates to this group implementation. The
executor checks cancellation before promotion and retires a child cancelled at
that boundary. Cancellation racing promotion still uses durable recovery; after
displacement begins, publication completes. Independent children retain separate
history identities. Same-object edits after version capture are rejected during
execution, not by the pure identity comparison. External writers are not excluded.

This provides exact preparation for independent **replacements** only. It does not
yet implement mixed ordinary/replacement transfer plans, ordered overlapping
requests, outer grouped-command settlement, whole-job cancellation, or the
paste/drop native batch command. A vector of prepared children is an internal
ownership transfer, not a renderer-facing batch API or a grouped history result.

### Ordered replacement receipts and contained execution

`files/batch/receipts.rs` is the shared ordered state ledger for deletion and
replacement execution. The admitted plan bounds its slot count. Operation families
retain their policies: deletion continues after ordinary failures, budgets trash
artifacts, and stops on uncertain work; independent replacements stop at the first
failure. Receipt storage does not choose cancellation, retry or artifact semantics.

The replacement executor owns its pending queue and receipt ledger outside the
child unwind boundary. It marks an item active before consuming it, records each
returned receipt into its preallocated slot without intervening callbacks or
formatting, and preserves confirmed earlier items when a later child panics.
After active-owner unwinding, it explicitly retires every unstarted child. Cleanup
errors are additive warnings and cannot erase receipts or change the active error's
classification. A pre-promotion panic can leave an abandoned reservation for later
native reclamation; it is conservatively uncertain without inventing catalog evidence.

Physical refresh paths are captured before child consumption, then deduplicated for
started items. Runtime publication follows native owner release. Both refresh and
inventory publication contain panics; completion diagnostics retain committed receipts
and exact inverse tokens. The production single-replacement path delegates to this
same group executor and projects its one typed result. Panic now returns WorkerFailed
at that boundary; the command already classifies it as uncertain filesystem work.

Copy and history use `diagnostics::Warnings`, preserving encounter order and
first-occurrence deduplication under 32-message/16-KiB bounds. The byte budget reserves
newline separators and the omission notice, so joining the vector cannot overrun it.
Warnings remain distinct from failures and do not stop later effects.

This is internal independent-replacement execution. The complete transfer command
still needs a mixed/ordered plan, one task registration and progress owner, an outer
ledger surviving worker/capture destruction, grouped native forward history, and
paste/drop IPC migration. Internal multi-child Rust tests do not prove those command
or UI contracts. No whole-batch filesystem atomicity or startup performance is claimed.

### Worker result ownership

Production copy executes through `files::worker::run_blocking_context`. Effectful
resources live in an explicit context; a function pointer performs the work so
owned closure captures cannot be destroyed before reporting its result. A
supervisor-owned result cell receives the work result before context destruction.
Separate unwind boundaries contain work and cleanup panics independently. The
supervisor awaits cleanup before projecting the result: confirmed success plus
cleanup failure is success with a warning; an ordinary error survives clean
cleanup unchanged; failed work plus failed cleanup is uncertain. Copy outcome
projection combines these warnings with replacement diagnostics while retaining
the exact native history token.

This boundary only preserves returned results. A grouped transfer must additionally
retain each completed item outside the entire worker, because work may panic before
returning its aggregate. Contexts must not contain multiple destructors that panic
while unwinding one another; separate work/cleanup catches cannot recover an abort.

### Ordered interactive transfer session — next implementation

The general copy command must own the ordered **request**, not pretend that all
of its eventual filesystem targets can be bound upfront. Current paste/drop add
a landed basename only after success. An earlier failed copy therefore cannot
manufacture a later conflict. Same-parent copies select a free name against the
filesystem when they execute. Eagerly resolving every dialog or binding every
replacement would change these semantics. Independent `reserve_batch` remains
appropriate for already-known independent intents; it is not a prerequisite for
the interactive ordered transfer command.

Use one native async session, one history admission, one cancellation registration
and one ordered receipt ledger. Validate and retain the complete bounded source
request before effects, but derive, reserve and bind each exact executable child
only when the preceding child's outcome and the current conflict decision are
known. Each child's immutable source/target/private-root bindings still precede
its own filesystem effects. This separates whole-request ownership from atomic
reservation of speculative children and preserves dependent duplicate names.

The async session owns conflict state and suspends between filesystem workers.
Its progress/decision channel reports the active item, remaining count and a
native-generated decision nonce. A separate resolve command verifies the originating
renderer generation, session, item and nonce before consuming one answer. Apply-to-all
applies only to subsequent actual conflicts. A late or duplicate answer cannot
approve another item. Native target observations are revalidated before execution;
dialog metadata is presentation, not mutation authority. Tauri documents channels
as a command communication mechanism in its
[calling-Rust guide](https://v2.tauri.app/develop/calling-rust/#channels).

Do not hold a blocking thread while waiting for a user decision. Blocking filesystem
work owns its resources through termination; stopping an async waiter does not
stop an already-running blocking task, as documented by
[Tokio](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html).
Renderer retirement closes unresolved decisions and cancels the unstarted suffix;
an accepted child still reaches its native cancellation/publication boundary and
settles its actual outcome. A failed progress delivery cannot erase a receipt.

On terminal completion, project confirmed ordinary-copy and replacement receipts
into one native history entry in request order (Undo executes in reverse).
Ordinary-copy inverses require a native published-object/version identity and
revalidation through the actual inverse mutation, not a path-only action or a
frontend preflight. Keep warnings, failures, uncertainty, skipped items and the
unstarted suffix distinct. Aggregate physical and requested refresh paths after
worker ownership settles. Byte estimation must remain independent of first-copy
readiness; one batch cancellation identity spans all children and pauses.

The migration must also address the current interaction inconsistency:
`performFileTransfer` collapses conflict Cancel into Skip, so multi-drop continues
where paste stops. Keep these as separate domain outcomes; Cancel should stop the
remaining group, while Skip advances it. Capture the failing multi-drop outcome
before changing that behavior. Move/cross-filesystem recovery remains a separate
executor under the eventual shared session, not an ordinary-copy inverse.

Acceptance requires one production group mixing ordinary copies and replacements,
one usable composite inverse, a failed earlier duplicate that does not create a
later conflict, same-parent unique names, apply-to-all after real conflicts,
cancel/panic after a committed prefix, stale decision replies and renderer loss
while waiting and while executing. Rust real-filesystem and native IPC tests must
establish these outcomes. This section is a design decision, not implemented
batch-command acceptance.

### Native ordinary-copy inverse observations

`FileMutationReceipt.publication` retains `PublishedEntry`: physical path, parent
ObjectId and EntryVersion. This is native-only data, not a serialized capability.
Staging resolves its parent before creating the private directory. Observed Linux
publication captures the staged version before temporary directory permission
changes, verifies the opened destination agrees with the physical staging parent,
and renames relative to those handles. Generic staged publication still uses its
existing path-based rename; this does not establish alias protection for every
operation family or another platform.

`copy_inverse` constructs native Copy history with the publication's physical key.
Action admission validates both path and parent against that observation. Undo
uses `trash_publication`, whose worker checks physical path, parent and full version
during selection observation, binds the same parent/version into preparation, then
uses existing execution revalidation before effects. The optional observation is
absent from legacy renderer Copy actions until ordered-session migration.

Restoration returns its actual parent and verified publication through the batch
receipt ledger. Native Redo replaces its old observation with that fresh one;
reusing the previous parent would create an unusable next Undo after parent
recreation. If receipt budgeting omits the new observation, or its path/parent is
inconsistent, settlement keeps the successful restoration and warns that its next
inverse is unavailable. Artifacts and publications share the existing transient
receipt cap; native history separately accounts retained observation allocation.

EntryVersion intentionally does not promise a recursive content snapshot, xattr
coverage or detection of inode reuse with restored metadata. Post-publication
permission/staging-cleanup errors in the generic staging helper remain logged;
failed permission restoration can cause subsequent version verification to refuse
Undo. Unifying those completion diagnostics remains part of transfer integration.

### Durable operation ownership

One native recovery coordinator owns a lazily opened, application-local SQLite
index. Use bundled SQLite through `rusqlite`, short transactions, rollback journal
mode and `synchronous=EXTRA` initially. Never hold a database transaction across
copying or user-volume filesystem calls. Reservation promotion holds its short
transaction across bounded private-catalog publication to keep capacity preflight
and kind transition serialized. A database commit and a filesystem rename are
separate commits; intent precedes the effect, and observed completion follows
the required filesystem durability barriers. See SQLite's
[atomic commit](https://www.sqlite.org/atomiccommit.html) and
[synchronous modes](https://www.sqlite.org/pragma.html#pragma_synchronous).

Before an artifact-bearing operation can move user bytes, publish an immutable
record in a fixed, bounded active catalog beside the index. It names the complete
operation intent and all predicted private artifact roots. Same-volume manifests
duplicate that intent at each artifact root. Paths use tagged, lossless native
encoding; IDs are generated natively. Record and aggregate limits reject new
work before displacement rather than evicting unresolved recovery.
The order is durable catalog intent, secure private-root creation, durable local
manifest, then user-byte movement; creating a root first cannot substitute for
publishing its discovery record.

Database loss can then fall back to this one bounded catalog, without searching
arbitrary siblings or volumes. Unknown schema, corrupt records and disagreement
between catalog and database preserve the evidence. Losing the entire recovery
catalog is outside automatic discovery; sibling manifests alone do not make
arbitrary paths discoverable.

The current catalog-only reader performs that bounded discovery without opening
SQLite, creating storage or probing user volumes. It returns validated intents,
not recovery capabilities. Its native path encoding includes the actual operating
system (`linux:`, `macos:`, `windows:`), because sharing a Unix byte encoding does
not make filesystem identities portable between operating systems. This v1 format
has not shipped; the earlier in-development `u:`/`w:` spelling is rejected.

Static validation requires source subtree ownership and destination/artifact-root
write ownership, complete captured ancestry for those existing-parent resources,
and distinct parent, original and artifact-root identities. The replacement spec
captures the source EntryVersion as well as its resource identity; staging cannot
silently adopt same-object content or permission changes after promotion.
A publication identity
is captured when staging completes; its presence does not prove publication happened.
The current operation kind is explicitly `copyReplacement`: the staged object must
be independent of the source, displaced original, private root and parent. The
unshipped ambiguous `replacement` kind is rejected. Move specifications and source
parking require their own future authority and state contract. `Planned` and
`RootIntent` have no root identity; `Rooted` and later phases require it.
`Staged` and later phases require the proposed publication version, including
restoration and discard. Unknown fields and malformed phase evidence
fence admission. These checks do not replace live identity checks, temporal phase
transitions or filesystem durability barriers in the still-pending mutation path.

The mutable journal checkpoint contains the catalog's SHA-256 digest and typed
operation state. Immutable intent and resource claims stay in the catalog rather
than being serialized into every phase update. A legal transition clones only
state, then verifies the named native owner, exact catalog bytes/object, prior
state and journal generation before compare-and-swap. An exact higher-generation
result can acknowledge a lost commit reply without another write; a changed
state at the held generation is rejected. This is a snapshot protocol, not an
authenticated history against arbitrary private database rewrites. Admission
still decodes bounded catalog/journal records; compact writes do not establish
constant runtime or peak heap usage. This unshipped format rejects earlier
full-intent journal rows.

The pure replacement policy separates root creation, manifest publication,
staging, displacement, publication, restoration and discard into intent and
completion phases. Successful observations/completions clear the current error;
starting a retry retains it until completion. Phase progression grants no native
effect capability by itself. The concrete preparer currently persists
`RootIntent`, exclusively creates and synchronizes the anchored private root,
records `Rooted`, persists `ManifestIntent`, publishes the exact framed manifest,
then records `Prepared`. Retained root handles bind the full intent digest,
including owner and resource claims. Read-only manifest verification never repairs
missing evidence. Promotion reserves room for the local manifest envelope before
publishing any catalog evidence, so a known format-size limit cannot first fail
after root creation. Failures and dropped owners retain evidence.

Private copy staging follows `StageIntent` and stores the observed staged payload
only after its filesystem durability checks. Its source and target entries are
addressed relative to retained directory handles, following the
[openat directory-descriptor rationale](https://man7.org/linux/man-pages/man2/openat.2.html).
Directory entries stream through independent native enumeration owners; one
transfer buffer is reused for the tree. Symlink text is copied literally through
[readlinkat](https://man7.org/linux/man-pages/man2/readlinkat.2.html) and
[symlinkat](https://man7.org/linux/man-pages/man2/symlinkat.2.html), including dangling
links, rather than traversing their targets. Work remains cooperatively cancellable
and partial private output remains recovery evidence. A staged root directory
retains owner access while its requested final mode is recorded alongside its
version. Publication must restore that mode through a retained handle before
reporting completion. The observed version is not a recursive point-in-time
snapshot; external writes to previously copied descendants and restored timestamps
remain outside the version contract.

The concrete executor now records displacement intent before retaining the exact
original at the private `original` child, then publication intent before moving
the staged payload to the public target. Both moves use native no-replace
[rename semantics](https://man7.org/linux/man-pages/man2/renameat2.2.html).
The result is classified from both exact entry versions: a reported rename error
can still mean the move occurred, while a success alone cannot prove it did.
Confirmed effects repeat root and target-parent
[directory durability barriers](https://man7.org/linux/man-pages/man2/fsync.2.html)
before recording completion. Directory publication retains its handle across
rename and restores the recorded final permissions through that handle. Authority
and endpoints are checked again before this separate metadata effect and after
barriers. Conflicting evidence is preserved without cleanup or replacement.

A verified executor may reassert the same displacement/publication intent to
reconcile a lost effect or completion reply. This still validates the exact native
owner, immutable catalog, checkpoint and generation; identical checkpoints avoid
an extra journal write. Native endpoint reconciliation, not an intent-phase label,
determines the next effect. Errors remain recorded until successful completion.
This does not infer completion from partial staging.

On Linux, a finalized directory may deny the ordinary read-open needed to repeat
its durability barrier after restart. Only that access failure for an exact
already-published copy permits reacquisition through the existing `O_PATH`
permission adapter. The held inode and named endpoints must match the final
version before restoring the recorded staged permissions. The adapter then
rechecks the staged version and opens the pinned inode for synchronization;
publication restores its final permissions through that readable handle. Both
possible interrupted permission states are therefore already in the journal's
version contract. Readable retries use the ordinary open path without temporary
permission changes. Changed authority or endpoint evidence stops further effects.
Native tests cover persisted `PublishIntent` reclaim/reopen, denied final modes,
interrupted permission preparation and namespace substitution. This does not
resolve macOS's lack of a public unreadable-directory reopen mechanism.

Real process-kill tests cover the completed displacement/publication effects before
their completion checkpoints; they do not establish power-loss durability or
crashes inside native syscalls. Discard/retirement, unindexed recovery inspection and production command integration
remain pending; restoration is described below.

For a recognized indexed operation, restart ownership reacquires the exact old
native lock and retains its immutable catalog authority. The request carries the
checkpoint generation that was inspected; a stale generation or non-operation row
is rejected. Complete catalog/journal validation and an overlap check precede
acquisition. A busy owner makes no journal change. A successful claim compares and
swaps identical checkpoint bytes to allocate a fresh global generation, revalidates
lock/catalog evidence, and retains the lock in the returned operation. No unrelated
reservation is reclaimed during a claim. Unknown or conflicting authority stays
fenced; even a dead overlapping reservation waits for ordinary admission cleanup.
A lost claim reply requires rediscovery of the new generation.

Artifact reopening occurs outside shared admission and requires the checkpoint's
root identity plus the exact local manifest. It creates and repairs nothing.
A real child-process test proves ownership exclusion before death, then claim,
reopen and completion after death at displacement/publication intent boundaries.
Missing/reservation-only checkpoints are not converted to `Planned`; no phase is
invented from the mere existence of a catalog. These cases, interrupted root/
manifest/staging effects, and missing database recovery still need their inspection
and resolution protocols.

Restoration now classifies all three entries independently: the retained original,
private copy and public target. It parks an unchanged public copy before returning
the exact original to an absent target, using no-replace renames for both steps.
An already-public original is a completed native observation, not an instruction
to move another object. A missing copied payload does not prevent returning the
exact original, but unexpected or duplicate occupants fence the action. Source
availability is irrelevant to restoring these independent objects. `RestoreIntent`
precedes effects and may be reasserted under exact ownership; `Restored` follows
confirmed endpoints and repeated root/parent barriers, including a retry that
starts with the original already restored. No payload is deleted by restoration.

A published copied directory may need its recorded staged owner permissions before
it can move back into private storage. Linux now pins it with
[`O_PATH`](https://man7.org/linux/man-pages/man2/open.2.html), verifies its version,
and changes only that retained object's mode with
[`fchmodat2` and `AT_EMPTY_PATH`](https://man7.org/linux/man-pages/man2/fchmod.2.html).
Only `ENOSYS` selects the older-kernel fallback: a validated procfs descriptor
directory and an exact held-object/magic-link identity comparison precede chmod of
that kernel-owned descriptor link. This is never a chmod of the former user path.
An unavailable procfs leaves an error with evidence preserved. The syscall number
comes from the already-used `linux-raw-sys` headers because the libc bindings omit
it on some Linux architectures. After preparing permissions, `openat(pin, ".")`
obtains a readable synchronization handle without resolving the original name.
All endpoint authority is rechecked before parking and after durability barriers.

The original's permissions are never relaxed to force displacement/restoration;
Linux can reject reparenting a write-protected original directory. Copied-directory
preparation changes only the independently staged copy, whose temporary mode is
already part of the durable contract. macOS has no identified public equivalent to
Linux's permission-independent reopen: ordinary `O_RDONLY` access remains required.
`O_EVTONLY` does not bypass read authorization for ordinary third-party applications
([XNU open authorization](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_subr.c),
[private entitlement gate](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c)).
Owner-unreadable published-directory recovery on macOS remains unresolved. No
platform substitutes a pathname chmod after an identity check.

Recovery storage needs an identity-checked directory anchor and handle-relative
access to private descendants. Checking only the final path component does not
protect against parent replacement. Platform adapters must establish and retain
this authority before SQLite or filesystem work uses the namespace.

### SQLite namespace boundary

The standard SQLite Unix VFS canonicalizes `/proc/self/fd/<directory>/...` paths;
that spelling does not make the database or its sidecars descriptor-relative.
The current coordinator precreates the private database through its directory
anchor, opens the existing canonical filename without CREATE/URI and with
NOFOLLOW, retains its file/directory handles, and checks the named identities
before and after journal access. Managed mutations must treat the recovery root
and its ancestors as protected resources. A mismatch poisons the connection and
requires reconciliation; the replacement path is never adopted automatically.

This detects namespace changes but cannot atomically prevent a same-user writer
from replacing the private namespace between a check and SQLite's pathname open.
In particular, initialization could touch a replacement compatible database before
the post-open check rejects it. Arbitrary external writes inside app-private
recovery storage are outside this implementation's guarantee. Stronger protection
would require an audited platform VFS covering the database, sidecars, locks and
flushes; a pathname check must not be described as that guarantee. SQLite documents
both its [filename open contract](https://sqlite.org/c3ref/open.html) and the
[risks of renaming an open database](https://sqlite.org/howtocorrupt.html#unlink).

## Admission, execution and reconciliation

All managed file mutations pass the same loaded-recovery conflict check, including
when a user acts before background discovery. Conflict reservations arbitrate
across native application processes: shared admission serializes overlapping
resource claims, and an exact OS-held owner lock covers their filesystem work.
A process-local map is insufficient. Ordinary reservations last for the operation;
creating persistent hidden artifacts additionally requires durable discovery
intent. Ordinary creation, rename and permanent deletion remain outside process
crash recovery until explicitly migrated; a reservation does not promise Undo
after restart. A known unresolved path fences overlapping work. Unreadable
records with unknown affected paths fence destructive file mutations until the
evidence is resolved, while browsing remains available. External applications
and uncoordinated filesystem writers remain interference to detect by identity.

Resource conflicts include both logical paths and physical parent namespaces.
Canonical paths alone retain bind-mount aliases, and two missing destinations
have no leaf identity to compare. Index every captured existing ancestor with
its remaining relative suffix, so a later capture after an intermediate directory
appears still meets the earlier claim at their shared physical ancestor. Preserve
read/read sharing and unrelated sibling concurrency. Entry identity also retains
hardlink conflicts; final symlink capture continues to own the link itself.

Capture also appends read claims for each parent symlink traversed by a request,
including aliases inside relative/absolute symlink targets. These claims fence
alias rename/replacement without serializing unrelated siblings. They have bounded
walk memory/depth and share the aggregate claim/record limits. Primary captures
retain request order; only those primary paths bind execution. Workers use these
captured paths, while symlink creation retains literal link text and probes its
captured target. Stable alias presentation is checked while read claims remain
active; native rename history always uses the bound committed path. Both requested
and resolved parents are refreshed. Receipts remain snapshots after settlement.

The Unix index encodes normalized native components once per claim, separated by
NUL (forbidden in native names), and shares those bytes across ancestor suffixes.
Ordered comparisons then avoid repeatedly parsing long component prefixes.
Subtree claims retain a minimal covering frontier, allowing a single predecessor
lookup for ancestor coverage. This encoding is private index state, not the wire
format or a portable case-folding rule. Windows per-directory case/short-name
semantics and case-insensitive macOS volumes still need native qualification.
Rust documents the underlying [component-based path comparison contract](https://doc.rust-lang.org/std/path/).

Session liveness uses an OS-held lock with recorded file identity and nonce.
Only successful acquisition of the exact abandoned lock establishes that its
owner is gone. Missing, replaced or unreadable locks are unknown. Each operation
also retains an exact lock handle and a database claim generation; every phase
transition compares the generation so a stale worker cannot settle another
claimant's work. Do not unlink actionable lock files.
Retired locks have a bounded cleanup lifecycle under exclusive shared retirement
arbitration, after proving no operation, claimant or catalog record can reference
them. Unlinking and recreating a live lock must never split its authority.

The shared lock guard owns an independently opened file and releases OS ownership
without deleting evidence. Unix retains whole-file advisory locking. Windows
locks one byte at offset 4096, beyond the bounded 32-byte nonce plus overflow
probe, so another process can still validate owner evidence. Each overlapped
Windows request owns a dedicated completion event and drains pending completion
before releasing its request storage. Missing or replaced admission gates
permanently fence the existing coordinator, including when the original filename
is later restored. This guard is infrastructure; production mutation admission
for remaining operation families and Windows runtime qualification remain incomplete.

Native object identity is a pure platform-tagged value, separate from handle
lookup and from entry-version validation. Windows capture retains the volume
serial and every bit of `FILE_ID_INFO.FileId`; Unix retains device/inode identity.
Volume comparison never substitutes for full object equality. Private durable
records reject foreign-platform and untagged identities. This unshipped format
change has no legacy recovery-data migration; no production operation has used
these records yet. Filesystem IDs may be reused after deletion, so these values
alone cannot authorize recovered artifacts after a restart.

The shared `files::entry_version` contract compares object identity, size, mtime
and kind; Unix observations also retain full mode, uid and gid. Recovery and Linux
trash use the same model and native capture. ctime and link count cannot identify
an unchanged payload: moving or restoring one hardlink changes the shared inode's
ctime and would invalidate another legitimate receipt. `.trashinfo` metadata has
no such legitimate mutation and retains strict ctime identity plus content digest.
Full entry-version comparison applies before execution, when classifying both
successful and failed moves, and before/after restore. A changed moved payload
retains evidence and reports an uncertain mutation instead of issuing Undo.

This is ordinary-change detection, not content/recursive-tree integrity. Coarse
or restored mtimes, extended attributes/ACLs/flags not reflected in mode, nested
descendant writes, identifier reuse and namespace races remain outside this
observation's guarantees. The additional required Unix fields belong to the same
unshipped format; missing fields are rejected rather than defaulted into authority.

Linux trash now performs whole-selection read-only preparation inside its existing
owned batch worker. All requested sources and parent-alias dependencies are
observed before destination planning, so an unrelated entropy/layout/candidate
failure cannot erase a selected ancestor's authority. Every executable plan
retains both usable fallback layouts and exact artifact names. The shared
namespace policy separates sources, exclusive artifacts, shared dependencies and
artifact containers: distinct non-directory hardlinks are allowed, while source
namespace duplicates, ancestor relationships and artifact overlaps are rejected.
Container checks are selection exclusions, not broad inter-operation locks on
all of Trash. Directory actions retain their read/create/repair classification.

The ledger passes its immutable path vector into setup by Arc; execution and
receipts preserve original order/spelling while plans retain captured native
paths. Whole-value layout interning and exact shared-resource deduplication bound
repeated state. The 32 MiB plan budget includes conservative source observation
and shared input charges; the existing 32 MiB encoded-resource and 32,768 unique
claim limits remain separate. Several claims belong to one file, so admitted
input count does not promise every such selection fits its expanded plan.

This planning does not acquire the still-required recovery reservation or publish
durable artifact authority. Linux casefold/provider aliases need stronger native
dirent identity before a universal namespace guarantee; case variants of one
non-directory entry can otherwise resemble distinct hardlinks. Those platform
observations and arbitrary external namespace changes remain qualification work.

Private-storage validation takes retained native handles rather than detached
metadata. Catalog, owner and coordinator callers share the same policy; Windows
combines protected ACLs with kind, reparse, link-count and delete-pending checks.
Unix rejects zero-link retired directories as well as nonprivate or multiply
linked evidence. These are observations: namespace verification and admission
remain separate requirements. System randomness failures propagate before any
owner or retirement namespace entry is created.

Linux simple-entry commands now acquire one lazy reservation from an application-
owned Runtime before dispatching their owned worker. Tauri state construction does
no filesystem or SQLite work. Initialization and reservation run on blocking
workers; concurrent cold initializers share the existing admission gate rather
than mistaking its appearance for a missing gate in populated storage. Each entry
worker retains a context clone through capture destruction. Settlement preserves
confirmed receipts/history and adds a warning if reservation cleanup fails; an
operation error still returns its original error, with cleanup failure logged.
Deletion, transfer, inverse, archive, plugin and Git roots remain required before
claiming full managed-mutation coverage. Windows/macOS production admission and
durable replacement/reconciliation/UI also remain incomplete.

The coordinator records intent before displacement, publication, restoration or
cleanup. Captured parent and payload identities govern each step; path spelling
and timestamps alone cannot authorize an inverse. Publication remains atomic
no-replace. Files and relevant parent directories must be synchronized before a
durable completion claim. On Linux, syncing a file does not by itself persist
its directory entry ([fsync](https://man7.org/linux/man-pages/man2/fsync.2.html)).
Windows/macOS adapters require separate flush and identity acceptance.
The [Windows adapter implementation brief](../reviews/windows-recovery-adapter-design-2026-09-08.md)
records the required handle-relative APIs, full-width identities, private ACLs,
independent locking and unresolved namespace-durability qualification. Shared
lock, identity and directory/privacy boundaries are implemented; this is not a
complete adapter or a platform acceptance result. Native Windows creation applies
a protected current-user/SYSTEM DACL in the create call. Ordinary inherited files
have a separate validation contract that also requires retained, validated parent
authority. Namespace sync currently returns `Unsupported`; the brief documents
`NtFlushBuffersFileEx` normal mode as a candidate requiring native qualification.

Reconciliation is a pure policy over durable intent plus observations classified
as missing, matching, different or unavailable. An intent without a completion
record does not prove that its syscall failed. Different occupants, unavailable
volumes and ambiguous identities preserve artifacts and require attention.
Startup discovery announces unresolved work; it does not silently overwrite,
delete or restore user paths. Recovery actions revalidate under a current claim.

Overwritten originals have explicit retention leases referenced by native
history. Dropping a Rust owner never deletes retained user bytes. History
trim/clear/retirement schedules lease release outside the history mutex. Cleanup
is itself journaled: durable retirement intent, identity-checked removal,
filesystem barriers, then completion and catalog retirement. An interrupted
cleanup remains discoverable. Retained-payload quotas and visible recovery
decisions must accompany overwrite Undo; the current in-memory history budget
does not bound filesystem storage.

## Startup and delivery boundary

Explicit Linux recovery IPC now runs through the same lazy blocking runtime as
mutation admission. Listing validates the bounded private catalog/index without
user-volume probes and never offers actions. Inspection acquires a fresh native
claim before reopening the exact root and manifest. The restoration offer uses
the native three-endpoint policy, and resolution reacquires the displayed
generation before revalidating and executing. Busy, stale and conflicting requests
preserve evidence; `Restored` retains the copied payload and requires later cleanup.
Discard is not offered while its native executor/retirement remains incomplete.
First discovery can show immutable catalog-only attention items after index loss;
an initialized runtime instead reports later storage failures without downgrading
its view to a revision-zero fallback. Discovery never repairs a missing index
over existing ownership evidence.

At the IPC boundary, journal generations and snapshot revisions use canonical
decimal strings bounded by SQLite's signed 64-bit range. This avoids the integer
interoperability limit described in [RFC 8259 section 6](https://www.rfc-editor.org/rfc/rfc8259.html#section-6)
and follows the established [decimal-string representation for 64-bit JSON integers](https://protobuf.dev/programming-guides/json/#int64).
The frontend validates and orders these strings without numeric conversion; action
requests parse a positive canonical generation back into native storage authority.
The private journal format is unchanged. The three explicit commands are registered;
subscription lifetime and UI activation remain separate unfinished integration work.

Initialize on a blocking owner after `WindowSession.markCoreReady`, or lazily
when the first mutation requires admission. Do not open, migrate, scan or repair
the journal in Tauri setup. Initial discovery reads the bounded index/catalog;
probing user or offline volumes is separately scheduled recovery work. This is
a startup constraint, not evidence that the half-bounce target is achieved.

First deliver a complete vertical integration into displaced-destination
ownership, with indexed restart discovery, a usable recovery surface and
subprocess crash tests. Then add overwrite Undo/retention, cross-device source
parking, move-overwrite composition and whole-intent batches. Do not count an
unused journal or policy model as delivered recovery.

Acceptance must kill the process at every intent/effect/completion boundary and
verify exact bytes after restart. Include competing claimants, interrupted GC,
disk-full commits, namespace substitution, occupied restoration paths, missing
volumes, database loss, history retirement during an inverse and actual separate
filesystems. Native Windows/macOS tests and measured launch/input latency remain
required. Portable recursive copy does not promise a point-in-time snapshot of
files still being written through existing descriptors or hard links.

## Reservation promotion protocol

Common `DurableIntent` authority contains the native operation ID, its exact
owner lock and captured resources. `OperationSpec` and `OperationState` contain
the operation-specific immutable plan and mutable evidence. Replacement artifact
tokens are separate from operation IDs: the artifact namespace is chosen before
admission allocates the owner. The catalog ID must match that owner's lock name.
This is an unshipped format change; old replacement-only shapes are rejected,
not silently interpreted as the new envelope.

Promotion consumes an exclusive reservation and returns a distinct durable
owner. It rechecks the stored generation, lock and complete resources, then
validates the typed intent and initial state. An immediate SQLite transaction
checks record capacity and revision availability before publishing the catalog.
Catalog publication writes exclusively and completes file and directory barriers;
retry of exact existing bytes repeats those barriers without replacing evidence.
Only then does the transaction change the row kind and generation together.
SQLite's [atomic commit](https://www.sqlite.org/atomiccommit.html) protects the
database transaction; filesystem publication remains a separate durability step.
No user-file effects execute inside this transaction or the admission lock.

An interruption after catalog publication leaves discoverable claims even if
the reservation is later reclaimed. A lost commit reply can adopt only the exact
initial operation and catalog without advancing the revision. Different specs,
changed phases, malformed records and partial catalog files preserve evidence
and reject promotion. Failure returns the reservation for retry/settlement;
ordinary settlement cannot retire a catalog. Outstanding worker contexts prevent
promotion, and cancellation of an async waiter cannot release the native owner
held by its blocking publication job. The durable owner has no ordinary `finish`
capability; its eventual retirement requires verified reconciliation.

These primitives do not yet authorize a production artifact executor. Root and
manifest preparation now have native subprocess kill/reopen tests, and replacement
phase persistence is implemented. User-byte replacement and trash execution,
reconciliation, UI, retention and process-kill acceptance across user-byte effects
remain required for the complete vertical integration.


### Recovery subscription ownership

Each exact acknowledged renderer lifetime has at most one latest recovery
subscription. Client tokens are positive, bounded signed-64-bit decimal strings,
allocated once per invocation from a counter retained by the JavaScript realm
across module reloads. Tokens are never reused or retried as new registrations.
Native state retains one high-water token per renderer until its retirement;
unsubscribe advances that fence even when it arrives before registration. A
stale release cannot remove its replacement. Initial discovery registers first,
and an uncommitted registration rolls back on failure or cancelled acknowledgement.

The registry is bounded to 128 renderer lifetimes. Owner retirement wakes a weak
registry task that removes the channel without another IPC request. Tauri IPC
channels retain webviews and therefore managed app state; native owner retirement
breaks that transitive retention, as covered by an explicit reference-cycle test.
Replacement,
release and failed delivery destroy callbacks outside the registry lock. Native
sealing cannot recall an already-running send, so callbacks and acknowledgements
also check the current realm token before delivering to the store.

List/inspect/resolve publish from the actual owned blocking worker, including a
best-effort authoritative inventory after an operation error; delivery failures
never change the operation outcome. This observes startup discovery and completed
same-process recovery requests. It does not add polling or claim cross-process
filesystem observation. UI inventory merges retain an inspected presentation for
an unchanged generation; invoking any displayed action still requires a fresh
native claim and endpoint validation. Recovery UI activation follows the page-owned lazy session described below.


### Page-owned recovery UI

The window session owns a lazy recovery session; importing its controller does
not import the recovery store or IPC implementation. After a successful listing
gets its existing paint opportunity, background readiness starts recovery for a
foreground window. A failed initial listing can independently enable recovery
after a paint opportunity without emitting the successful-startup timing marker.
Parked warm windows wait for successful activation acknowledgement; picker windows
never construct this session. Explicit user demand may start recovery immediately.

Each page creates its own recovery state. Concurrent demand shares one pending
load/registration, late imports cannot attach after disposal, and repeated disposal
awaits the same cleanup promise. Manual refresh reconnects the subscription, so a
failed initial registration can recover without polling. Discovery errors remain
visible and do not simultaneously claim that no items need recovery.

The notice accepts presentation props and stays lightweight. With the status bar
hidden, attention gets its own compact row; File Recovery is also available in the
command palette. The dialog uses the shared lazy-dialog and modal ownership seams.
Before disabling/removing an action control, it parks focus on Close; completion
can focus the surviving same-row Inspect control only while the original modal
and focus still belong to that action. A closed/reopened dialog keeps its own focus.
Browser port fixtures validate presentation and interaction only. Actual native
recovery effects and Tauri channel/webview teardown still require binary acceptance.

### Completed-operation ownership

Durable evidence and active mutation ownership have different lifetimes. The
initial implementation indexed every catalog resource forever, freezing source
and destination even after a successful copy or restoration. Ordinary admission
and recovery claims now share an effective-claims index. Only a validated,
error-free `Published` or `Restored` checkpoint with an independently acquired
idle native owner may reduce its claims. Published operations retain the private
root and original; restored operations retain the root and copied publication.
The root's checkpoint identity and retained payload identity augment the recorded
namespace, protecting relocated roots and direct hardlink aliases. These derived
claims never rewrite immutable intent and do not assert current endpoint existence.

Live owners, incomplete phases, catalog-only records and errored checkpoints keep
full declared authority plus every known artifact identity. Invalid indexed
checkpoints or missing/substituted completed owner locks fail admission. Explicit
recovery expands to full declared and known-artifact claims before acquiring its
native owner and advancing generation. This prevents an obsolete operation from
reclaiming a copied object now retained by a successor overwrite.

Every authority acquisition passes the same process mutex and persistent admission
gate. Idle-owner probes close while that gate remains held; keeping a descriptor
for every completed record would make the 1,024-record limit exhaust common file
descriptor limits. A separate-process regression positively observes that the
admission gate is busy after the idle owner probe closes, then proves the new
reservation excludes recovery until it settles. No in-memory completion flag or
filesystem path probe is used to weaken persisted ownership. Runtime enablement
remains Linux-only. Artifact retirement, retention budgets and recovery-backed
history are still required before the complete production overwrite lifecycle.

### Production Linux copy replacements

The acknowledged `copy_entry` command now owns a native forward-history admission
and settles confirmed/uncertain effects from its independently owned task. Shared
copy naming and progress dispatch stay in the filesystem layer. Only existing
Linux destinations use durable replacement execution; ordinary copy publication
and non-Linux overwrite adapters still require the remaining ownership migration.

A prepared replacement owns the exact reservation and bound source/target/root
paths. It observes versions and parent identity against those captured resources,
then exclusively promotes before creating artifacts. It stages the independent
copy before displacing the original. Cancellation is honored before displacement;
once the original is parked, publication finishes without a cancellation point.
Post-promotion failures retain evidence and report uncertainty rather than promise
ordinary temporary-copy cleanup. Task registration is RAII-owned through panic.

Runtime inventory publication belongs to the same worker after effect ownership
ends, including failed work and unwinding. Inventory failure logs a diagnostic and
adds a warning to a committed reply, without retrying effects or inventing an
inventory revision. A lost caller cannot receive that warning, so discovery after
an inventory failure remains explicitly best-effort. The prepared physical parent
survives worker failure and is published through the existing watcher/cache seam
when distinct from the requested parent; history settlement publishes the caller's
spelling. This prevents alias copies from stranding physical-path cached listings.

Replacement receipts identify retained native recovery records. Single and batched
frontend transfers must not record these as ordinary Copy inverses: removing the
new file alone does not restore the displaced original. The command now records a native Replacement inverse; the File Recovery dialog
can also explicitly restore it. Production paste/drop copies now share native grouped ownership as described below.
Discard/retirement and retention quotas remain required before
this lifecycle is complete or qualified for release.


## Retained-copy reapplication and semantic history validity

The replacement executor can now cycle Published → RestoreIntent → Restored →
ReapplyIntent → Published. Reapplication uses the retained independent copy at
`root/publication`; the original source may have changed or disappeared. It
requires exact original/private-copy/target observations, persists ReapplyIntent
before effects, then reuses native displacement and publication. Conflicts retain
all evidence. Reconciliation can resume from either rename boundary or restore the
original instead. Missing copied data forbids reapplication even though restoration
can still recover an intact original without that copy.

Journal generation remains an ownership/UI concurrency token: every exact claim,
including Inspect, advances it. A separate persisted `effect_revision` advances on
confirmed PublicationCompleted, RestorationCompleted and ReapplicationCompleted.
Intent entry checks that the next revision is representable before permitting
native work. Legacy checkpoints default this newly introduced revision to zero;
no overwrite history was minted for those checkpoints. No history migration or
retroactive token minting is introduced.

Native history admission takes a semantic Published/Restored position and content
revision. Under the existing admission lock it validates this pair, exact catalog
and checkpoint evidence, overlapping claims and native ownership, then advances the
current journal generation. Inspect does not stale history. A completed mutation
cycle does, even when it returns to the same position. Pending intents cannot be
claimed through this stable-history entry point and require recovery.

Native temp-directory tests exercise repeated file/directory/dangling-link cycles,
source deletion, competing owners, stale tokens, changed/missing copies and foreign
target insertion. A subprocess is killed after each rename and after completed
publication; fresh ownership resumes and restores both versions with directory
permissions intact. These demonstrate process interruption with the kernel alive,
not power-loss guarantees. Entry-version observation retains its documented limits
on nested writes and metadata-preserving changes. The production command now mints a native-only Replacement history action from
its confirmed receipt. History retains only the operation ID, content revision and
non-authoritative refresh directories, while the renderer receives a display path.
Renderer admission recursively rejects replacement actions and deserialization
cannot recreate their skipped native token. The existing owned inverse supervisor
captures refresh directories before work, executes directional native recovery,
settles history and publishes filesystem changes once. The inner recovery worker
publishes inventory after its native owner drops, including uncertainty or panic.

Success creates an opposite with the fresh content revision. Stale/busy admission
is unchanged and retains the original inverse; an error after execution starts
consumes that inverse as uncertain and leaves explicit recovery evidence. Clearing
or evicting history never deletes durable recovery artifacts. A destroyed window's
local history is retired even when its accepted effect finishes: surviving windows
receive recovery inventory and file changes, without inheriting that local Redo.
Native acceptance gates an actual replacement Undo, destroys its child window,
releases it externally and verifies both versions, the surviving row's updated size,
recovery generation and isolation of the surviving window's history.

Completed work carries warnings independently of execution failure. Inventory
publication and retention diagnostics do not stop dependent batch effects; real
failures preserve the ordered completed/opposite/remaining partitions and stop
subsequent effects. The shared accumulator preserves first-occurrence order and
limits diagnostic content to 32 messages and 16 KiB of UTF-8, including an omission
marker. Frontend completion and Redo survive warning-only replies.

Native file-change publication carries mutation origin into the existing refresh
policy. Its fixed frontend coalescing deadline bypasses watcher throttling, while
active scans still finish before reconciliation and observation-time/navigation
guards retain their current owners. This does not guarantee delivery within a
native polling interval or a presented-frame deadline.

Artifact retention/retirement remain required. Production paste/drop copies now
group ordinary and replacement inverses through the ordered session below.


## Ordered interactive copy ownership

`files::copy_session` owns the complete ordered paste/drop copy request. Independent
replacement batches can prepare all children together; interactive copies instead
inspect each child after preceding effects, because duplicate source paths and
conflicts created by earlier copies are meaningful. A conflict captures the source,
parent and target observations shown to the user. Linux execution verifies those
observations before allowing publication or replacement preparation.

One renderer-owned registration bounds the session, with at most 128 registrations,
32,768 sources per request and an 8-MiB aggregate path budget. Conflict replies carry
the exact item and a process-wide non-reused nonce as well as the owning request.
The native Ready event closes the early-cancellation handshake; the renderer remembers
an abort until that event. Resolving a prompt releases its renderer slot before
awaiting IPC acknowledgement, allowing the next native conflict to arrive promptly.

The supervisor retains ordered receipt slots before launching work. Renderer loss
retires cancellation and waits for active blocking work to settle; it does not abort
the filesystem worker. Confirmed ordinary and replacement inverses become one native
history batch. Cancel leaves the completed prefix; Skip advances to the next item.
Failed children preserve their diagnostics, and uncertain active work stops the suffix.
Per-item diagnostics share a 64-KiB raw UTF-8 budget; session warnings use the existing
separate 16-KiB collector. These are content bounds, not serialized wire-size claims.

Request-local progress avoids global job-event collisions. Directory work starts
without a recursive size prewalk. Ordinary Linux copies reuse anchored staging and
identity validation with buffered writes; recovery replacements retain file and
parent durability barriers. Buffered ordinary copying does not establish power-loss
recovery. Ordinary recovery admission, move sessions, artifact retention, and native
Windows/macOS qualification remain open. Acceptance and its exact platform limits
are recorded in `docs/reviews/recovery-copy-session-2026-09-09.json`.


## Move admission before durable relocation

Forward moves and native history moves now consume the same `MovePlan`: bounded
absolute source/destination input, a fixed source leaf and target, source/target
subtree write claims, and the paths returned by native admission. Resource capture
resolves parent aliases while preserving a symlink leaf. The plan is pure; filesystem
execution and presentation metadata live in `files::move_execution`. The actual
blocking context owns the reservation until work and context cleanup finish.

The forward command owns native history settlement before replying and invalidates
Redo after a confirmed or uncertain effect. Existing frontend paste/drop code still
groups path-based Move inverses; this is not ordered move-session completion.
The inverse adapter uses the same recovery runtime and returns additional physical
refresh parents and cleanup warnings to its existing history supervisor. Cleanup
warnings do not revoke a completed move or its opposite; incomplete source removal
continues to consume the inverse without offering a destructive retry.

These reservations coordinate managed application operations. They do not pin the
source/parent objects against external replacement. A copy replacement record
cannot stand in for a Move intent: it describes an independent copied payload and
does not encode the source's disappearance and recreation. The
[rename contract](https://man7.org/linux/man-pages/man2/rename.2.html) and
[GIO move contract](https://gnome.pages.gitlab.gnome.org/gtk/gio/method.File.move.html)
distinguish those execution paths.

### Executable durable moves

`OperationSpec::Move` now has its own state contract and phase machine rather
than borrowing the replacement's: `MovePhase`/`MoveState` in `recovery/move_model.rs`
and the pure legal transitions in `recovery/move_transition.rs`. Parking and source
removal exist only here, and a same-filesystem move without an overwrite reaches
`Published` from `Planned` with no artifact root at all — one
`renameat2(RENAME_NOREPLACE)` remains the fast path.

The transition function, not execution discipline, enforces the crash ordering.
`BeginPark` is reachable only from `Published`; `BeginSourceRemoval` only from a
durable `Parked`; `BeginRestoration` is unreachable from `Removed`, because the
exact original no longer exists. An overwritten destination is displaced into
private storage before publication. Nothing in the forward path deletes a user
entry, and restoration never removes a published destination before the source is
verified back at its own name. `recovery/move_execution.rs` addresses every
endpoint through retained parent handles and classifies each rename from both
observed versions, as replacement transfer does. Artifact-root ownership is shared:
`Anchor::open_plan` opens any planned private namespace, so move roots reuse the
replacement manifest, namespace and durability discipline.

Undo executes the durable record itself, claimed by ID, revision and stable
position — `Published`, `Parked` or `Removed` for a completed move — never a
renderer-supplied path, which for a cross-filesystem move could relocate the last
copy of the data. A move record has no reapplication: `ReplacementOutcome::reapplicable`
is false, so history produces no opposite whose evidence is gone. Effective
admission claims treat `Published | Parked | Removed | Restored` as released
endpoints and retain only the private artifact roots, so either public path can be
reused after the move.

Acceptance so far is Linux real-filesystem contracts (`test_support/recovery_forward_move.rs`),
process kills at every effect boundary including cross-filesystem staging, parking
and source removal (`test_support/recovery_move_execution.rs`), and pure transition
contracts. Still required: ordered interactive move sessions with partial receipts,
conflict revalidation and cancellation; native forward history grouping for those
sessions in place of the renderer's path-based Move inverses; artifact retention
and retirement (#687); and Windows/macOS adapters and qualification.
