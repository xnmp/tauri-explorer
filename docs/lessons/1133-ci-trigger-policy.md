# Heavy CI belongs after every dev merge

The existing split was incomplete: macOS Smoke, macOS Native UI and Windows
installer still admitted PRs. Several other heavy workflows had dev path filters,
which meant some merged commits received no qualification at all. All seven
heavy-only workflows now admit every dev push and manual dispatch, with existing
schedules retained. Windows smoke remains in the native smoke workflow, whose
PR matrix selects Linux and whose dev/default dispatch matrix selects both OSes.

`cancel-in-progress: false` alone does not preserve all dev runs: GitHub allows
only one pending run in a concurrency group and replaces an earlier pending run.
Heavy-only workflows need no concurrency block. CI and native smoke use the PR
ref only for PR runs and a unique run ID otherwise; cancellation is PR-only.

`tests/ci-trigger-policy.test.ts` reads the actual workflow YAML consumed by
GitHub, pinning the PR workflow allowlist, native matrix, unfiltered dev triggers,
dispatch and concurrency contracts. All ten tests failed against the original
workflow files before implementation.

The rollout also requires a live administration change: remove `launch-smoke`
from dev's required contexts while retaining `frontend`, `rust`, `webkit`,
`smoke (ubuntu-latest)` and `code-maps`. Do this before publishing the trigger
split, then verify the branch endpoint reports that exact remaining list.
Do not substitute a dummy success job for the removed heavy check.

The prepared credential could read the dev branch's embedded protection summary,
but lacked administration access; protection reads and writes returned HTTP 404.
The owner then removed `launch-smoke`, as recorded in the
[rollout confirmation](https://github.com/xnmp/tauri-explorer/issues/1133#issuecomment-6202744110).
The branch endpoint confirmed the exact five remaining cheap required contexts
before the workflow change was first pushed. This ordering prevents PRs from
waiting on the removed heavy check without weakening the remaining requirements.
