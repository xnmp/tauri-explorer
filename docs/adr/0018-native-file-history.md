# ADR 0018: Native file history and mutation receipts

Status: Proposed — implementation in progress; native acceptance and transaction boundaries remain open.

Governs: `src-tauri/src/file_history/`, `src-tauri/src/files/mutation.rs`,
`src/lib/domain/file-history.ts`, `src/lib/api/file-history.ts`,
`src/lib/api/native-resource-session.ts`, `src/lib/state/undo.svelte.ts`.

## Context

Broadcasting copies of renderer-local Undo stacks cannot prevent two windows
from executing the same shared inverse. A renderer can also disappear after
accepting work, leaving surviving windows with stale history. The per-path
progress policy in [ADR 0017](0017-file-batch-outcomes.md) needs one authority
for shared admission and settlement.

File commands also returned a `FileEntry` assembled after mutation. A failed
metadata lookup could therefore report failure after a successful rename,
move or creation. That is a presentation failure, not an unapplied mutation.
Rust's [rename contract](https://doc.rust-lang.org/std/fs/fn.rename.html) and
[metadata contract](https://doc.rust-lang.org/std/fs/struct.Metadata.html)
describe separate filesystem operations; combining their errors loses the
commit boundary.

## Decision

The native application owns independent histories for registered renderer
owners. Explicitly shared actions reference one native entry ID in each
participant's history. A single application-wide inverse reservation prevents
duplicate execution; ordinary local pushes remain local. Clear generations
and push branches govern how partial results settle into surviving histories.

Registration uses the existing native resource-session acknowledgement with
an ordered summary channel. The requesting renderer generation is captured
before asynchronous native listener installation. A delayed old request cannot
adopt a replacement renderer or replace its channel. Virtual-only windows
acknowledge after core readiness; ordinary directory panes reuse their existing
acknowledgement.

The renderer retains revisioned summaries, not executable history. Undo/Redo
captures the expected entry ID at user intent. If local writes are pending, it
uses the last already-admitted write's receipt, never a later channel snapshot.
A changed top entry causes native admission to fail without executing another
action. The native executor settles independently of the invoking renderer and
publishes affected directories through the existing native refresh path.

Execution distinguishes completed effects, recoverable opposite actions and
remaining work. An unsupported trash restore cannot become a promised redo.
An executor panic produces an unknown-outcome error, consumes the uncertain
inverse without automatic retry and invalidates every potentially affected
directory. This does not provide native-process crash recovery.

Seven entry-producing file commands return `FileMutationReceipt`:
`{ path, entry }`, where `entry` is a nullable presentation snapshot. Receipt
construction after commit is infallible. Metadata failure is logged and yields
`entry: null`; it cannot revoke the committed path. Consumers always record and
publish the committed path, use an available snapshot for optimistic updates,
and otherwise reconcile through the existing originating-pane refresh seam.
Clipboard rekeying retains its last-known metadata when no new snapshot exists.

The TypeScript executor is confined to the browser fixture backend. Native
execution and history policy are tested in Rust; a browser simulation cannot
prove native admission, watcher timing or renderer-independent completion.

## Acceptance still required

### Partial move outcomes and explicit replacement ownership

`FileMutationReceipt.recovery`, when present, reports a committed destination
with incomplete or uncertain source cleanup. It contains source and destination
paths, the cleanup error, and an optional retained displaced-original path.
Recursive source removal may have deleted any subset of the source; neither a
Move inverse nor a Copy inverse is safe, because the destination may contain
the only surviving copy of some children. Forward consumers invalidate redo
without adding an inverse, reconcile both parents, and report the incomplete
operation. Native inverse execution consumes the affected leaf with completed
effects and an error, retaining no opposite or retry; untouched batch siblings
remain available. This is explicit partial progress, not automatic recovery.

Copy and move overwrite share `files/replacement.rs`. An exclusive directory
and original-path record are created before displacing the existing target;
automatic directory destruction is relinquished before any user bytes enter
it. Rollback uses no-replace rename. A collision preserves the racing target
and reports the retained original. An incomplete move retains that original
instead of rolling it back over the committed destination. Complete overwrites
still remove displaced originals, so full overwrite Undo is not implemented.

The original-path record supports manual inspection. It is not a durable
transaction journal or globally discoverable recovery index. Failed capture
can leave an empty recovery record, and cleanup failure after a complete
overwrite can retain data reported only through native logs. Native identity,
bounded retention and startup reconciliation remain required. Parking a move
source before copying is deliberately deferred until durable journaling and
reconciliation can land with it; otherwise a process crash could strand the
only source under a hidden name before any destination exists.

Incomplete paste marks its progress operation as an error with no retry
handler and a `Paste incomplete` message. Safe siblings remain undoable; an
incomplete cut keeps the original clipboard selection, including paths of
already-moved siblings. Precise pruning must coordinate OS clipboard ownership
before replacing that payload.

### Publication prerequisite

`files/publication.rs` owns newly created, unpublished payloads in an exclusive
destination-local staging directory. Unix staging is created with mode 0700.
Ordinary copies and new text writes publish only after their contents are ready.
The shared no-replace rename uses Linux `renameat2(RENAME_NOREPLACE)`, macOS
`renamex_np(RENAME_EXCL)`, and Windows `MoveFileExW` without replacement or
cross-volume-copy flags. Unsupported filesystems fail rather than emulate the
contract with a check followed by a replacing rename. Linux trash restore reuses
the same primitive. Recursive copy creates each destination entry exclusively.

These are OS namespace guarantees, not durable transaction recovery. See the
[Linux rename contract](https://man7.org/linux/man-pages/man2/renameat2.2.html),
[Apple's rename contract](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/rename.2),
and [Windows MoveFileEx contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).
In particular, NFS can report an error after a rename took effect. This requires
artifact identity and an indeterminate publication outcome before an error can
universally be interpreted as proof of no mutation. A case-only rename still
uses the existing platform rename branch after its same-entry check.

Staging cleanup never intentionally owns displaced originals. Overwrite
displacement now uses the explicitly retained `replacement.rs` owner described
above; durable reconciliation and complete overwrite history remain open.
Staging itself is still addressed by path: a process running as the
same user can replace the staging directory or one of its ancestors between
operations. Mode 0700 does not provide identity anchoring against that actor;
publication and cleanup need native handles/identity before claiming protection
against arbitrary external namespace replacement.
Cross-device publication now uses exclusive staging, but deleting
the source afterward can still fail partially: Rust's
[`remove_dir_all` contract](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html)
does not promise all-or-nothing removal. The recovery receipt now separates the committed destination from incomplete
source cleanup and suppresses its unsafe inverse. Durable reconciliation and
combined native forward completion/history admission remain required.

Native acceptance exposed a publication boundary for read-only directories:
Linux requires write permission on a directory moved between parents to update
`..`. Publication now temporarily grants owner read/write only on the newly built
payload root in private staging, retains a directory handle, and restores the
exact copied mode through that handle after commit. It never changes source
permissions. Restoration failure is logged without revoking committed success.
A real-filesystem regression fails before this fix and passes afterward; the
Linux native cross-device case also verifies both exact copies, the destination
listing, an incomplete-paste error and absence of an unsafe Undo. Read-only
nested staging cleanup and arbitrary namespace substitution remain open.

### Remaining acceptance

- Real multiwindow inverse admission, passive peer settlement and initiating
  renderer closure while an inverse is accepted.
- Durable recovery for cross-device source cleanup, failed staging cleanup and
  overwrite rollback. Current receipts and retained paths expose partial
  effects, but do not reconcile them automatically or after native-process loss.
- Recorded native artifact identity before path-based destructive inverses;
  retained displaced artifacts for complete overwrite recovery.
- Native forward mutation/history admission ownership: the current separate
  push leaves a renderer-loss and concurrent-ordering gap.
- Windows/macOS restore and lifecycle acceptance, final browser/native
  integration, and actual macOS startup measurements.

Retention is bounded at 256 entries and 32 MiB **per registered client**, with
shared entries retained by reference. This is not an application-wide memory
budget and does not bound all transient execution clones or retained filesystem
artifacts. No startup latency improvement is claimed by this migration.
