# ADR 0014: Observed directory navigation

Status: Accepted

Governs: `src/lib/state/pane-watch.ts`, `src/lib/state/directory-events.ts`,
`src/lib/state/directory-listing.ts`, `src/lib/state/pane-refresh.ts`,
`src/lib/state/explorer.svelte.ts`, `src/lib/api/files.ts`,
`src-tauri/src/files/dir_listing.rs`, `src-tauri/src/files/directory_watches.rs`

## Context

Scanning before watching leaves an unobserved interval: an external write after
that scan can remain invisible indefinitely. Installing a listener after initial
tab setup adds another gap. Routing events only to the committed path loses
changes for a navigation whose initial response has not yet reached the UI.
Starting an old-path refresh during that navigation can also cancel its stream.

## Decision

Each pane subscribes to one shared window-native directory event hub. Navigation
waits for event and renderer-session readiness, then invokes one native command
which establishes renderer-owned observation before scanning. The lease remains
under a native drop guard throughout scanning. A quiet navigation requires one
foreground scan; normal refreshes reuse the committed observation.

A pane navigation ticket stages the returned lease before the listing transport
publishes callbacks. Committing the new path and initial snapshot transfers this
lease to the pane and retires the previous one. Failure keeps the previous
committed observation. Supersession and teardown reject late replies and retire
the exact lease, independently of subsequent same-path requests.

Pending-path changes are retained by `pane-watch`, then sent through the existing
`refresh-manager` after commit. Changes for the old path are replayed on failure.
Refresh callbacks recheck navigation ownership before starting or publishing.
Scheduler coverage belongs only to the panes that actually accept a refresh;
a callback deferred by navigation must not suppress that pane's later replay.
The policy remains WHEN=`refresh-manager`, WHETHER=`pane-watch`, HOW=`pane-refresh`.

Observation demand and OS coverage are distinct. A readable directory remains
browsable during transient watcher failure. Such a lease retains recovery demand
but does not make caches eligible; the existing observation service publishes a
refresh when coverage recovers. Demand arriving during failed physical cleanup
waits under its own lease identity and is promoted after that cleanup completes.

## Consequences

Navigation has an explicit observation dependency instead of a fire-and-forget
post-listing side effect. No redundant catch-up scan runs on a quiet path. An
actual change during handoff requires a trailing refresh. Observation and scan
latency still require native measurement; this decision does not establish a
startup time target or guarantee OS delivery during an observation outage.
