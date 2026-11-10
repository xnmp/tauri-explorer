# #1581 — a window could adopt another search's stream events

**Symptom.** Quick Open (and content search) could show results for another
window's query, or the final batch of a search this window had just cancelled.

**Cause.** `search-results` / `content-search-results` are app events delivered to
every window. Until a run's start IPC returned its stream id, the run adopted
the id of the first event it received, whoever's it was.

**Rule.** Never infer identity from a broadcast. Attribute an event to a run only
by the id that run's own start IPC returned; hold earlier events per id
(`domain/stream-correlation.ts`; latest-only for Quick Open's full snapshots,
all for content search's increments) and release only the matching stream's
when the id arrives. The backend registers the id immediately before replying,
so holding costs one IPC round trip. A frontend-supplied client token would
also work but needs an IPC contract change; this fix needs none.
Tests: `tests/state/quick-open-session.test.ts`, `tests/composables/use-content-search.test.ts`.
