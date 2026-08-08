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
