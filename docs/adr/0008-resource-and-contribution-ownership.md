# ADR 0008: Asynchronous resources and contributions have explicit owners

Status: Accepted

Governs: src/lib/state/directory-watch.ts, src/lib/state/preview-lifetime.ts, src/lib/state/terminal-session.ts, src/lib/state/owned-registry.ts, src/lib/state/git-graph-cache.ts, src/lib/state/git-summary-cache.ts, src/lib/state/git-graph-refresh.ts, src/lib/state/git-repo-watch.ts, src/lib/domain/git-warm.ts, src/lib/state/repo-root-cache.svelte.ts, src/lib/plugins/api.ts, src-tauri/src/task_registry.rs, src-tauri/src/terminal.rs

## Context

Feature growth exposed the same failure across unrelated surfaces: work started
by an old owner could finish after navigation, replacement or closure. Cleanup
by a reused path, numeric ID or object value could then delete the replacement.
A cache invalidated during a read could be repopulated by that obsolete read.

## Decision

Keep policy in importable domain functions and resource lifetime in state or
native services. A component acquires an explicit owner for its mount lifetime;
it does not implement a private cache or refresh policy.

- Capture the owner before the first asynchronous boundary. Every completion
  checks that ownership before publishing. An obsolete acquisition is released,
  not silently abandoned.
- Teardown detaches synchronously and drains already-started cleanup. A
  replacement can become interactive while the old owner drains independently.
- Native refcounted watch acquisition and release are serialized within an
  owner. Sharing a native watch does not mean sharing frontend ownership.
- Cache publication requires a captured writer registration. Invalidation
  revokes pending writers as well as stored values. An old finally block may
  remove only its own pending entry. Bound retained cache values separately
  from active work. Summary invalidation detaches joinable scans as well as
  retained values. A failed/cancelled summary cannot become a cached clean tree.
- Reload requests revoke the active generation immediately, even if execution
  must wait for the current read. Unmount revokes publication and discards
  queued work. All callers can await the serialized reload drain.
- Contribution identity belongs to each registration invocation. A disposer is
  idempotent and cannot delete a replacement, even if it reused the same value.
  Plugins cannot silently replace existing commands, menus, dialogs or provider
  schemes. Explicit core replacement contracts remain available.
- Native client task IDs cannot replace an active task's cancellation flag.
  Terminal reservations are window-owned and atomically claimed once; an ID is
  not authorization to control another window's terminal.
- Restored inactive tabs reserve pane identities and descriptors; their first
  activation creates explorers and starts fresh directory loads. Reading state,
  saving, exporting and closing an unvisited tab cannot accidentally activate it.
- Cross-window tab moves retain the source until a correlated destination
  acknowledgement proves adoption. Native window construction or event delivery
  alone is insufficient. Late subscription acquisition must still be released.
- Accepted plugin work belongs to the window, independently of the activation
  that contributed its UI. Register event coverage before submitting work and
  reconcile events that precede the returned job ID. Terminal events apply once.
- Settings, theme synchronization and optional plugin startup form one
  window-owned sequence. Teardown revokes late settings completion before
  releasing plugins; core readiness precedes optional plugin activation.
- A mounted graph has separate history-query, commit-detail, PR-detail and branch-metadata
  owners. They consume the existing reloader and cache; they do not create a
  refresh policy. Pagination captures the displayed query and resolved branch
  walk, including on a cached remount. Partial history and complete summaries
  have distinct publication responsibilities; an append never replaces the
  retained page-zero cache. Every append owns its loading-state cleanup.
- Shared graph snapshots are immutable at ingress, including parents, refs and
  walk arrays. Readonly getters share owned payloads without cloning histories
  during rendering. This follows Svelte's raw-state replacement contract for
  immutable collections ([Svelte $state.raw](https://svelte.dev/docs/svelte/$state#state.raw)).
- Branch metadata distinguishes unknown coverage from a known empty list.
  Hidden-remote queries fail closed if initial coverage is unavailable; later
  failures may use established coverage. Query/popover request supersession
  drains the current replacement before a caller uses its result.
- Commit-detail transitions use the existing comparison domain. Inline diffs
  additionally capture the index/worktree side and request invocation; one
  partially staged path can appear in both groups. Mutations capture the detail
  selection before awaiting native work, so their later refresh cannot replace
  or close another selection. A failed scan cannot establish a clean tree.
- Numeric preference constraints live in the domain and must cover every numeric
  Settings field at compile time. Config/cache input and direct updates validate
  before publication; interactive setters clamp finite values through the same
  rules. Counts require integers; preview dimensions distinguish zero defaults
  from usable positive sizes. Continuous presentation values retain fractions.

Keep resource-specific owners small. This does not introduce a general async
framework or a fourth refresh gate: refresh-manager still decides WHEN,
pane-watch WHETHER, and pane-refresh HOW.

## Verification contract

Test obsolete completion, close during acquisition, replacement with the same
identity, repeated disposal, acquisition failure and retry. Use production
functions and observable outcomes. Native resources also require real temporary
filesystem/repository/PTY tests or native application tests. Browser fixtures
alone cannot establish backend timing or operating-system resource cleanup.

Independent review must try to falsify concurrency and performance claims.
Release startup acceptance remains a measured native macOS result; JavaScript
payload reduction is supporting evidence, not a half-bounce result.
