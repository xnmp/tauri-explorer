# #482: adaptive watcher refresh backoff

Directory watcher refresh policy belongs in `state/refresh-manager.ts`: that is
the single WHEN layer shared by every watcher source. The pane refresh callback
already returns the directory-listing promise, so the manager can time the
actual listing lifecycle without creating another IPC timing channel.

When a listing exceeds the recent healthy baseline by a large multiple, retain
at most one pending watcher request until it settles, then schedule that
trailing request with an extended interval. Do not learn a new baseline from
the degraded sample; a later healthy listing must restore normal cadence.

Pending async refreshes can outlive watcher teardown. Guard completion with a
manager generation so an old listing cannot schedule work for a newly-created
watcher.

On WebKitGTK, WebDriver-injected scripts can run in an isolated JavaScript
world. A test-side assignment to `window.__TAURI_INTERNALS__.invoke` may appear
to succeed and remain readable to later WebDriver scripts without affecting
the application world's Tauri calls. Configure dev-only application probes
through DOM `CustomEvent`s and publish observations through DOM state instead.
Publish hook readiness before the driver dispatches an operation, dispatch it
once, and acknowledge completion with a matching DOM token. Re-dispatching a
navigation on every polling interval queues duplicate directory listings that
can begin after a watcher timing probe is installed.

A refresh-manager callback can run well after its watcher event. Bind the
callback to the path captured when the event arrived and re-check the explorer's
current path before refreshing. Calling `explorer.refresh()` unconditionally
lets a late event for directory A list directory B after the pane navigates,
while the manager still attributes its timing and rate limit to A.
