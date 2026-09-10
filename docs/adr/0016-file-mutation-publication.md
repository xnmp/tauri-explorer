# ADR 0016: File mutation publication and editor ownership

Status: Accepted

## Context

A filesystem operation can succeed after its initiating pane navigates, closes,
or opens another editor. Previously, completion read the pane's current path,
appended into its current listing, and closed the current global dialog. Delete
undo also recorded the completion-time pane directory, including when a Miller
column supplied entries from a different parent.

The one-second local-mutation cooldown discarded watcher refreshes without
remembering them. A causal external write in that interval was therefore hidden.
A path-specific cooldown would still lose unrelated changes in the same directory.

## Decision

Explorer captures each operation's destination and existing navigation generation
before asynchronous work, including clipboard reads. A completion may update the
pane only while that generation, path and pane lifetime remain current. Creation
and paste additionally preserve selection/cursor changes made while pending.
Successful results are merged by path because a watcher can observe them first.

Filesystem success remains durable after pane retirement: undo, clipboard/cache
identity updates, operation status and affected-parent broadcasts do not borrow
pane lifetime. Archive broadcasts derive from the actual output. Delete undo
groups actual entry parents; individually confirmed permanent deletions publish
even when a later item fails. A live pane inside a deleted ancestor still escapes
to an ancestor outside the removed tree.

Rename/delete openings have independent opaque identities. Completion closes only
the admitting opening. Explicit delete entries do not borrow an unrelated global
dialog. Creation is one optional session, retired on navigation and disposal.
Rename focus, error and submission completion follow the exact opening; pending
inputs are read-only and retain keyboard focus for an error or retry.

Remove the mutation cooldown and its forced-refresh bypass. Refresh-manager owns
coalescing/rate limits, pane-watch owns observation/navigation admission, and
pane-refresh avoids unchanged-listing publication. An own-write echo may cause a
confirming scan; silently losing unrelated changes is not a valid optimization.

This follows the request-identity publication guard used in asynchronous state
systems (for example [Redux Toolkit's current request ID example](https://redux-toolkit.js.org/api/createAsyncThunk#examples)), while retaining this application's existing navigation owner.
Cancellation of accepted filesystem work and cancellation of UI publication are
separate decisions; this change does not add a framework or a cancellation layer.

## Verification and remaining scope

Deferred public explorer tests cover navigation away/back, disposal, early watcher
publication, newer selection/editor sessions, clipboard reads/transfers, exact
undo parents and partial permanent deletion. Browser tests exercise failed rename
retry and reopened editors in Details, List and Tiles. The native acceptance case
holds a real successful creation, navigates to another observed directory and
requires a causally acknowledged external write there, then returns to the origin.
Current results and limitations are recorded in the completion ledger.

At this checkpoint, non-permanent bulk trash still reported aggregate failure
despite potentially partial native success, and undo lacked concurrent request
reservation. [ADR 0017](0017-file-batch-outcomes.md) follows this decision with
structured per-path outcomes and renderer-local history ownership; its platform
and cross-window limitations remain explicit.
No startup latency or Mac half-bounce improvement is established by this change.
