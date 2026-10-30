# #1443 — a reveal that beat the lineage load was hidden by grouping

`revealEntry` asked the lineage grouping for the file's chain once, at reveal
time. Right after navigation the grouping (or the lazily loaded tree
policies) is often not there yet: the pane-lineage module or the provider's
first load is in flight, possibly past the 400 ms first-paint hold. The file
was then selected at depth 0. When grouping landed, the file moved under its
parent's closed peek, and the peek prune (`prunePeekSelection`'s `regrouped`
predicate) deselected it.

Fix: the prune that runs on every projection change now asks
`lateRevealChain` (domain/folder-peek-pane.ts) first. If the file the user
revealed (`revealedPath`, which is cleared as soon as the selection moves
away) sat at depth 0 and grouping has just regrouped it, the explorer opens
its chain and exempts it from the regroup prune. A file that hid from inside
a peek, through a user collapse, is never reopened. `revealEntry` itself now
just opens the chain when it can and always selects.

Traps:
- The old path waited for `peek.activate()` and then compared grouping
  *objects*. The projection is rebuilt whenever its listing input changes, so
  the identity check failed and the reveal was silently dropped. Hook the
  projection change instead of awaiting.
- The startup bundle is within ~200 bytes gzip of its cap. A first version
  with a pending-reveal effect in explorer-lineage cost 147 bytes; folding the
  logic into the existing prune cost far less.

The browser repro only failed on the slow local dev server. The e2e now
forces it with the test provider's `delay`: 250 ms falls inside the hold and
700 ms after it.
