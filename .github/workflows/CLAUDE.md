# CI trigger policy

Only `ci.yml` and the Linux matrix entry in `e2e-tauri.yml` run on PRs.
The heavy suites listed in `tests/ci-trigger-policy.test.ts` run on every dev
push without path filters and retain manual dispatch. Existing schedules stay.

Do not use a shared concurrency group for dev pushes, even with
`cancel-in-progress: false`: GitHub replaces an earlier pending run in that
group. Heavy-only workflows omit concurrency; mixed PR/push workflows group
PRs by workflow and full PR ref, and use a unique run ID for other events.

Trigger changes and required-check changes must be coordinated. Before
publishing removal of macOS Smoke's PR trigger, remove `launch-smoke` from dev's
required contexts, preserving every cheap required check. The branch endpoint
exposes required contexts to push credentials even when the protection endpoints
return 404 because administration permission is missing. A workflow edit cannot
change branch protection.

Run `bunx vitest run tests/ci-trigger-policy.test.ts` to validate admission.
