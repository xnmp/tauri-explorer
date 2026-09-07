# Git observation leases

Status: Accepted

Governs: `src-tauri/src/git_watch.rs`, `src-tauri/src/git_watch/`, `src/lib/api/git.ts`,
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
keeps one lazy renderer-generation slot in that window's resource table, independent of
its reusable label. Acquisition and release obtain the identity from Tauri's
injected `Window`; it is not supplied by renderer arguments. The builder's native
`Destroyed` callback creates/finds and retires the token under the same resource
table lock. Closed state remains with old native handles, so even a delayed first
command cannot reopen ownership, and a new window with the same label starts with
a fresh token. No global registry retains closed-window labels. Resource lookup
scans that window's resource IDs, since Tauri's table is not a type map; creation
under the table lock ensures exactly one slot. Page-load callbacks only inspect existing slots, so
ordinary startup neither allocates Git ownership nor starts its worker.

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
run cleanup. Committed document replacement also retires the previous renderer's
owner: the global Tauri `on_page_load` hook advances its generation on `Started`.
Same-URL reloads are replacements; SPA navigation within the same document is not.
The app currently has one application Webview per native Window. Independently
navigating child Webviews would require moving this generation to Webview identity.

Each JavaScript realm lazily acknowledges `git_watch_session` before its first
watch and shares that promise among concurrent callers. Every watch/unwatch carries
that generation. The native slot checks it under the same locks as page/native
retirement before cloning the worker owner. Delayed old-generation acquisition is
rejected; old release is an idempotent no-op because retirement owns cleanup. Work
already accepted by the worker retains its retired cancellation token and cannot
acknowledge stale coverage. Failed session acknowledgement may retry; a failed
watch must never silently adopt another renderer generation. Generation exhaustion
fails closed. Native destruction is terminal even if a later load callback arrives.

In installed Wry 0.55.1, Started maps to committed navigation on GTK/WKWebView and
ContentLoading on WebView2, rather than a navigation attempt which may be denied.
Waiting for Finished would let the new document request coverage before the old
owner is retired. A destroyed realm cannot consume a late session acknowledgement
and issue new watch requests with it. The existing dedicated worker/coalesced wake
handles retirement; there is no heartbeat or periodic idle work.

A crash followed by reload is covered at that replacement boundary. A crash which
leaves the renderer blank indefinitely remains open: Tauri's general API has no
cross-platform process-termination callback. Apple has a dedicated hook; native
WebKitGTK/WebView2 termination integration and real acceptance remain separate work.
Large-repository cost, OS watch-resource drainage, and Windows/macOS lifecycle
acceptance also remain open. This decision does not establish Mac startup latency.
References: [Tauri page-load hook](https://docs.rs/tauri/2.11.5/tauri/struct.Builder.html#method.on_page_load)
and [Apple process termination hook](https://docs.rs/tauri/2.11.5/tauri/struct.Builder.html#method.on_web_content_process_terminate).
