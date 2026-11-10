# #1579 — a superseded content search's late cancel removed its replacement's listener

**Symptom.** Typing quickly (or clearing then retyping) in content search could
leave the new search loading forever with no results.

**Cause.** `start()` awaited `cancelContentSearch(oldId)` and only then tore down
"the" listener, held in one shared slot. A newer `start()` (or `reset()`) ran
meanwhile and installed its own listener in that slot, so the late teardown
removed the live search's listener.

**Rule.** A stream's resources belong to its run, not to a shared slot. Leaving a
run detaches its captured listener synchronously, then sends the cancellation
IPC without awaiting it; nothing a later run owns may depend on that IPC's
completion. A listener whose registration resolves after its run was superseded
is released on arrival. Same rule as Quick Open (#600, #651).
Tests: `tests/composables/use-content-search.test.ts` ("late cancellation").
