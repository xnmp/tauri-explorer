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
the unchanged native-suite subprocess compiler check, then the parallel unit
group, with the same timeouts, all cycles and assertions, and CLI worker
overrides. The compiler check also exhausted its deadline under parallel
transforms; a separate phase preserves its original test. No production
lifecycle change is needed.

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
the actual scheduler at both phase boundaries without repeating 5,001 activations
or invoking a second compiler inside a parallel unit test. This removes
contention between the test projects; it cannot promise immunity to unrelated
host load.

Graph reference disclosures capture the scroller's actual position when opened.
A native scroll notification can arrive after the click for positioning that
already happened. Compare positions rather than dismissing on every delivery;
inherit the snapshot into scoped actions and focus with preventScroll. Subsequent
vertical or horizontal movement still dismisses the anchored menu (#1082).

The native suite's public TypeScript command uses incremental compiler metadata
under node_modules/.cache. Repeated typechecks must still validate changed imported
contracts and recover after errors; do not alter the existing five-second test
deadline to compensate for host load. Metadata is disposable, not acceptance proof.

The new native cache contract probe also runs before parallel unit transforms, in its own ordered project after the unchanged public compiler check. Preserve exhaustive selection and worker overrides.

Compiler regression probes resolve TypeScript's CLI through Node package
resolution from the test module. Review checkouts may inherit dependencies from
an ancestor; a checkout-relative node_modules/typescript path is not portable.
Keep the real compiler and every cold/warm/error/recovery assertion intact.
