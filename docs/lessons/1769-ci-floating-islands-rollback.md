# CI recovery: Floating Islands tab rollback

The first failing dev CI run after PR #1744 failed only Chromium's closing-tab
pixel test in `e2e/floating-islands.spec.ts`. Every attempt rejected step 1 with
“the held frame never stood still”: the test could not establish a stable
shown/hidden/shown screenshot comparison. The isolated local run passed, so
that pass does not establish that the sampling protocol is deterministic.

PR #1744 was the sole merge after the preceding green dev CI run. Revert the
whole PR to restore the known-green application and its matching tests rather
than remove the assertion, widen the pixel tolerance, or retry until green.
Reintroducing the feature needs deterministic frame sampling under CI load.
