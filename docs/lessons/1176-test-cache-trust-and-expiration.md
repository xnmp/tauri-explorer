# Test-result cache trust and expiration

A cache probe controls whether CI installs browser/system dependencies. Expire
entries before that probe, for readers as well as writers. Carry its cutoff
through execution: crossing the TTL after a hit must not trigger a fresh run
without setup. Preserve entry mtimes through artifact transport with a tar
envelope; zip upload/download alone need not preserve them.

A `TEST_CACHE_WRITE` condition in a PR-editable workflow cannot authorize cache
writes. Neither can a directory outside the checkout: running PR code can write
there. GitHub's merge-ref isolation protects dev from PR-created shared caches,
but it still allows a forged pass to satisfy subsequent runs of the same PR.

Result artifacts are now accepted only from successful CI push attempts on protected
dev in this repository, selected using GitHub API provenance and downloaded by
artifact ID. GitHub's artifact service prevents PR runtime credentials from
uploading into a dev run. Same-repo PRs are read-only too; accepting their results
would require a protected producer outside PR-controlled code. Missing trusted
results run the tests, trading hit rate for an enforceable boundary.

Regression coverage uses real Turborepo entries: an aged pass must trigger setup
before execution, while a forged PR artifact must not hide a subsequently failing
test command. The positive control restores a dev-owned artifact and replays its
passing log through the same transport.

A rerun changes a workflow run's current status and conclusion; a discovery query
filtered by `status=success` loses its earlier passing artifacts while the rerun
is queued/in progress. Discover dev push runs independently of conclusion,
include the current rerun even if it is older than the discovery window, and
verify each artifact's producing attempt through the workflow-attempt API.
Check its completed/successful state and source/workflow/repository provenance
before restoring; the current attempt's state does not invalidate an earlier
successful one. A real-Turborepo regression verifies replay without executing the
test command while a later attempt is in progress.
