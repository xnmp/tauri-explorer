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

The native smoke workflow's manual `trash` scope runs the real Windows Trash
spec alone and uploads its filename capture and provenance in the WDIO logs.
It preserves the full suite for dev pushes and the default `all` dispatch.

# PR test selection (#1175)

On `pull_request`, ci.yml's `changes` job narrows each tier from the PR merge
diff (`HEAD^1...HEAD`) and nothing else: `scripts/e2e-affected.mjs` (browser
specs), `scripts/unit-affected.mjs` (`vitest related` inputs) and
`scripts/rust-affected.mjs` (`cargo test -p` members via `cargo metadata`).
Each publishes `ALL`, `NONE` or a list plus a reason, and every test step logs
which it ran and why. Pushes and manual runs always use `ALL`. Any doubt is
`ALL` for that tier: a selector failure, an unknown file type, an unusual path,
or more than `TEST_SELECTION_MAX_FILES` (50, set on the `changes` job) changed
files. A Rust `NONE` also skips the toolchain, fmt and clippy steps; the
dorny/paths-filter docs-only gate is unchanged and runs first.

`vitest related` follows imports only. Tests that read files as text are found
by the selector's text scan (path or basename, or the directory for tests that
list directories); a test reading a path it builds dynamically from neither is
invisible to it, so name such inputs literally. Rust inputs outside `src-tauri/`
count only when a string literal ends in their basename (`include_bytes!`,
fixture joins), not when a comment mentions them.
