# Git observation leases

Status: Accepted

Governs: `src-tauri/src/git_watch.rs`, `src-tauri/src/git_watch/`,
`src/lib/state/git-repo-watch.ts`, `src/lib/state/git-graph-coverage.ts`,
`src/lib/state/scm.svelte.ts`

Git queries can outlive their views through retained snapshots. Observation
therefore belongs to query/cache owners, independently of mounted graph and SCM
panels. Acquisition must acknowledge complete native coverage before a read can
be retained. Delivered changes revoke pending writers as well as snapshots.

Native acquisition returns a unique lease ID and its resolved repository root.
Release uses the ID and is idempotent. A repository path is display/event identity,
not permission to decrement another caller's reference. Frontend ordered owners
retain the lease after failed release and retry it before acquiring a replacement.
SCM and the graph share that owner.

Each native lease also belongs to the concrete calling window. The Tauri adapter
keeps one lazy cancellation token in that window's resource table, independent of
its reusable label. Acquisition and release obtain the identity from Tauri's
injected `Window`; it is not supplied by renderer arguments. The builder's native
`Destroyed` callback creates/finds and retires the token under the same resource
table lock. Retired state remains with old native handles, so even a delayed first
command cannot reopen ownership, and a new window with the same label starts with
a fresh token. No global registry retains closed-window labels. Resource lookup
scans that window's resource IDs, since Tauri's table is not a type map; creation
under the table lock ensures exactly one token. This does not start the Git worker
or allocate the token on application startup.

Retirement flips cancellation state and requests a nonblocking worker wake. A
coalesced retirement flag survives a full inbox. The worker reclaims retired
leases before recovery, retaining observers shared with live windows. Queued
acquisition checks the token, and registration that finishes after retirement is
drained before acknowledgement. Other windows' releases are idempotent no-ops.
The native event callback never waits for blocking observer registration or drop.
This uses Tauri's [concrete-window event hook](https://docs.rs/tauri/2.11.2/tauri/struct.Builder.html#method.on_window_event)
and [window resource table](https://docs.rs/tauri/2.11.2/tauri/trait.Manager.html#method.resources_table),
with cooperative cancellation as described in [Tokio's shutdown guidance](https://tokio.rs/tokio/topics/shutdown).

A lazy dedicated worker owns the native observer registry and all debounce and
recovery deadlines. The main async runtime only sends bounded commands and awaits
acknowledgements. Native callbacks set coalesced per-generation dirty/broken flags
and attempt a nonblocking wake; they do not append an unbounded event history or
create timer threads. Scanning flags after each command also covers a full inbox.
The worker sleeps until a command or its next deadline, with no idle polling.

Runtime errors retire the failed observer and invalidate subscribers. Recovery
re-discovers worktree/private/shared Git paths, verifies repository identity, and
reinstalls complete coverage with exponential delay capped at 30 seconds while
leases remain. Recovery must successfully enqueue an invalidation before new
healthy acquisition is acknowledged. Failed emission stays pending and is retried.
Old callbacks retain only their retired generation's flags. The final release
drops observation and its recovery deadlines; application shutdown joins the worker.

Recursive roots cover the worktree and shared metadata without overlapping roots
inside one observer. Non-recursive parent watches detect root movement/replacement;
unrelated sibling paths are filtered. Ignore non-mutating Access events and
temporary `.lock`/`~` files only inside Git metadata. Worktree lockfiles remain
ordinary changes. Rescan flags always invalidate, even without paths.

This follows notify's [channel-based callbacks and parent-deletion requirements](https://docs.rs/notify/latest/notify/)
and the [single-owner message-passing model](https://tokio.rs/tokio/tutorial/channels).
UNC live panels retain their existing 15-second poller; hidden cache owners decline
UNC retention so they neither add persistent network scans nor promise fresh cache
hits between polls.

Native delivery is eventual, not a transaction with the filesystem. The completed
snapshot cache is bounded; live leases and per-tree OS watches are proportional
to active owners and tree size. Native installation itself is synchronous on the
dedicated worker and can delay queued operations on very large or remote trees.
Native window destruction reclaims owners, including when the renderer does not
run cleanup. A renderer crash/reload which leaves its native window alive is a
separate lifetime boundary and is not detected here. Large-repository cost, OS
watch-resource drainage, and Windows/macOS destruction acceptance remain separate
acceptance; this decision does not establish the macOS startup latency target.
