# #1082: PR mutation verification and suite contention

GitHub mutation confirmations must bind the hostname as well as the repository
slug. A mounted graph cannot own pending native work: repository-scoped ownership
must survive remounts, and native admission must cover concurrent windows.
Lost acknowledgement after remote acceptance needs an uncertain outcome and an
explicit check before retrying. ADR 0006 records the behavioral proof.

The full operator suite exposed a timeout in the unrelated 5,001-activation
registry regression under CPU contention. Its expectations were correct, so an
attempt to optimize the existing test was refused by the immutable-test gate.
Restore the file unchanged and use ordered Vitest projects: churn runs before
the parallel unit group, with the same timeout, all cycles and assertions, and
CLI worker overrides. No production lifecycle change is needed.

Vitest merges inherited include arrays by concatenation. Put explicit includes
in each project rather than inheriting the full unit glob into the churn
project. The new runner-configuration integration test resolves the real Vitest
projects and checks exhaustive, non-overlapping file selection, scheduling order,
single-file commands, unchanged deadlines and worker-override propagation. Run
the complete unit and performance suites before publication.

Resolved group numbers alone do not prove execution order. The independent
review found that Vitest sends isolated order-zero projects to a trailing group
when `maxWorkers=1`. Use positive ordered groups. The execution regression binds
lightweight real worker modules to the production-selected projects and journals
module admission and churn completion for one- and two-worker runs; it exercises
the actual scheduler without repeating 5,001 activations inside a parallel unit
test. This removes
contention between the test projects; it cannot promise immunity to unrelated
host load.
