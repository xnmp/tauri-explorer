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

- Real multiwindow inverse admission, passive peer settlement and initiating
  renderer closure while an inverse is accepted.
- Structured outcomes for cross-device source cleanup, failed copy cleanup and
  overwrite rollback. A committed destination must not be retried as an
  unapplied move. Partial text writes also need an owned publication boundary.
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
