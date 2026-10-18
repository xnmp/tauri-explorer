# 1281: a debounced path-filter reload retired the merge-base jump

**Symptom.** `git-graph-merge-base.spec.ts` "jump to the common ancestor ... clearing a path filter" failed ~1 in 20 (11/30 at dev `af653188` under 2 workers): `.commit-row.selected` never appeared.

**Cause.** Typing in the path filter arms a 200ms debounced `reload()`. The view's `reload()` calls `branchSession.cancelMergeBase()` (any reload invalidates a pending lookup). If the debounce fired while `gitMergeBase` was still in flight, the jump itself was retired, so `current()` was false and nothing was revealed. The old code cleared the timer only inside the reveal callback, which runs after the lookup resolves, so it was too late. The suspected "filtered reload overwrites the reveal's query" part did not occur: the query owner already guards by generation and query key.

**Fix.** The pending reload is `createDebouncedReload` (`state/git-graph-debounced-reload.ts`), and `jumpToMergeBase` takes an `onStart` hook run synchronously at acceptance; the view passes `filePathReload.cancel`. Typing after the jump starts still retires the jump (intended).

**Rule.** Anything that will call `reload()` later must be cancelled when a lookup that a reload would cancel starts, not when it reveals. Keep pending timers in importable state modules.

Test: `tests/state/git-graph-merge-base-filter-race.test.ts`.
