# #1082: PR mutation verification and suite contention

GitHub mutation confirmations must bind the hostname as well as the repository
slug. A mounted graph cannot own pending native work: repository-scoped ownership
must survive remounts, and native admission must cover concurrent windows.
Lost acknowledgement after remote acceptance needs an uncertain outcome and an
explicit check before retrying. ADR 0006 records the behavioral proof.

The full operator suite exposed a timeout in the unrelated 5,001-activation
registry regression under CPU contention. Preserve all cycles and observable
contribution checks. Strict Node assertions avoid thousands of matcher wrappers;
one deterministic failure fixture avoids repeated stack capture and formatting.
Neither changes the production lifecycle, failure-report counts, cleanup checks,
timeout or worker settings. Isolated timings are diagnostic observations, not a
portable performance guarantee; verify the complete suite before publication.
