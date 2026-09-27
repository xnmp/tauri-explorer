# Session cancellation needs a pre-worker fence

An accepted cancellation request and a settled session are distinct points.
Once an item has committed, settlement must retain both its filesystem effect
and history receipt. Before a worker starts, however, cancellation must keep the
boundary effect-free.

The ordered session previously checked cancellation before publishing
`Started`, then launched the worker immediately afterwards. A cancellation
racing through the `Started` callback could therefore start an ordinary move;
that move uses an atomic rename and cannot observe the progress cancellation
flag before committing.

Keep stable orchestration boundaries observable through the crate-private
session observer and gate tests without sleeps. After publishing `Started`,
recheck both renderer ownership and cancellation before recording the affected
directory or launching the worker. Tests should cancel while parked, release
the engine, await full settlement, and compare source/destination residue with
the projected history. Cancellation after apply completion is allowed to leave
a committed destination only when the retained receipt records that effect.

The qualification table is:

| Boundary | Gate | Expected residue/history after settlement |
| --- | --- | --- |
| Ready published | session observer | no effect, no history |
| Inspection complete | session observer | no effect, no history |
| Conflict decision pending | real conflict event/reply channel | no new effect after cancel; any completed prefix remains recorded |
| Before `Started` | session observer | no effect, no history |
| Started published | session observer plus worker-entry fence | no effect, no history |
| Copy in progress | real byte-progress cancellation | partial destination removed, no history |
| Apply complete | session observer | committed residue and matching history |
| Receipt retained | session observer | committed residue and matching history |
| Completed published | session observer | committed residue and matching history |
