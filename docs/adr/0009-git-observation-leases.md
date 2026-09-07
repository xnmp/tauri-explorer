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
Crash/window-owner reclamation and large-repository cost require separate acceptance;
this decision does not establish the macOS startup latency target.
