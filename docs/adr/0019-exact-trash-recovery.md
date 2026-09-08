# Exact trash recovery

Status: Proposed; platform acceptance remains incomplete.

Governs: `src-tauri/src/files/trash*`, `src-tauri/src/files/freedesktop_trash.rs`, `src-tauri/src/files/windows_restore.rs`, `src-tauri/src/file_history/`.

## Problem

An original pathname is not a deletion identity. If the application deletes A,
another process creates and deletes B at the same path, selecting the newest
trash entry during Undo restores B. A real filesystem regression reproduced this
through the native history executor.

## Decision

The platform deletion returns an opaque, native-only receipt. History retains
that receipt on the action leaf; it never enumerates trash to choose an inverse.
Copy and Delete alternate between capturing a fresh receipt and restoring the
captured receipt. Partial settlement filters paths and receipts together. Renderer
input cannot supply receipts or record Delete actions, including nested actions.

Linux uses the Freedesktop trash layout with exclusive metadata reservation,
mount-ID-aware placement, descriptor-relative no-replace rename, metadata digest,
and file identities. Restore verifies the captured metadata and payload before
publishing to an unoccupied destination. It does not fall back to copy/delete
when the selected trash cannot accept a same-mount rename.

Windows captures the Recycle Bin item supplied by the source-verified
[`PostDeleteItem`](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-postdeleteitem)
completion callback and retains its desktop-absolute Shell parsing name. COM
objects remain on the batch's STA thread; history stores data only.

A committed deletion without a usable receipt remains completed and carries an
explicit warning. It is not retryable and cannot manufacture an inverse. A
verified pre-mutation failure retains the receipt for retry. Ambiguous effects
are consumed as uncertain and retain discoverable recovery data where available.

The filesystem receipt cap bounds transient storage. A separate, shared history
retention policy includes the complete action and entry costs. It budgets both
partial-settlement positions together, preserves remaining work first, and warns
when completed recovery cannot fit. For dependent batches, only a contiguous
prefix in the next execution order may survive; skipping an oversized prerequisite
to retain a later action is unsafe. Normal history trimming evicts older entries.

## Limits and required follow-up

This is live-session trash identity, not a durable transaction journal. Process
recovery, persistent manifests, overwrite recovery, native cancellation and
source parking still require the broader operation design. macOS programmatic
restore remains unavailable. Windows runtime, real Linux cross-mount acceptance,
Windows batch alias admission, and namespace interference require further proof.
No startup or deletion-throughput improvement is claimed by this migration.
