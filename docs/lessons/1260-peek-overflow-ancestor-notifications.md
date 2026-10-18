# 1260 — An evicted peek can receive an ancestor refresh

The reported smoke run passed on Linux. Its Windows case-outcome artifact had
one failure: Folder Peek expected `unnotified.txt` to remain absent for 2.5 seconds,
but the file was already listed. The console excerpt stopped in an unrelated
clipboard spec; the retained case outcomes and application log identified the
actual failure.

The direct watcher ignored the new file's Create/Modify events because the peek
had no lease. Windows also reported Modify for the containing directory. Its
watched parent legitimately published a root notification, and the ordinary pane
refresh correctly re-listed the overflow peek. No-lease does not imply no refresh
(ADR 0013 and ADR 0014).

Test the contract with an independently evicted leaf, rather than the ancestor
of a still-watched nested peek. Verify its null lease, write a file, and explicitly
change that directory's timestamp so the same real ancestor event occurs on
Linux. Require a causal application-side root receipt and the fresh child row.
Keep explicit refresh, the 16-lease cap, nested Git badges, create/delete, pruning,
collapse/reopen and native retirement assertions.

The old negative assertion fails on Linux as well when that metadata event is
introduced before it. Correct the expectation instead of suppressing legitimate
native notifications or extending a wait. Fake-timer overflow contracts retain
coverage of the case where no notification is delivered.
