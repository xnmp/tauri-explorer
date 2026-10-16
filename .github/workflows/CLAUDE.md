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

# Test-result cache (#1176)

ci.yml runs the unit tests, each Rust suite (fmt, clippy, tests) and each
browser shard through `scripts/test-cache.mjs run --task ci:<target>`, which
runs the matching `turbo.json` task. Turborepo hashes the task's inputs (every
git-tracked file minus the task's `!` exclusions), `package.json`, `bun.lock`,
`turbo.json`, and the env vars it lists: the selection (`UNIT_SELECTION`,
`RUST_SELECTION`, the shard's `E2E_SHARD_SPECS`), feature flags, `RUNNER_OS`,
`RUNNER_ARCH`, `ImageOS`, `ImageVersion` and `TEST_CACHE_TOOLCHAIN` (bun/node,
or rustc/cargo plus the apt candidate versions of `TEST_CACHE_APT_PACKAGES`).
An unchanged hash replays the passing log and reports
`<target>: passed from the test-result cache`. Turborepo never stores a failed
task, so a failure always re-runs. Browser and Rust jobs probe first and skip
browser, apt and build-cache setup on a hit.

Trust: the cache directory is `$RUNNER_TEMP/turbo-test-cache`, outside the
checkout (the script refuses a path inside it), so files a PR commits can
never be read as entries. `actions/cache/restore` and `actions/cache/save` are
split, and the save runs only when `TEST_CACHE_WRITE` is true (dev pushes and
same-repo PRs) and the run stored a new result. Fork PRs and manual runs read
only (`--cache=local:r`), and local machines have no access to the CI cache.
GitHub scopes a PR's cache entries to that PR's merge ref, so even a PR that
edits this workflow cannot write an entry that dev or another PR reads. Keys
are `test-cache-v1-<os>-<arch>-<image>-<image version>-<target>-<run>`, so a
Linux result can never satisfy a Windows or macOS job. Bump `CACHE_VERSION` in
the script to discard every entry.

Each exclusion in `turbo.json` must cover only files the target never reads:
`tests/test-cache.test.ts` scans each target's readers for repository paths
and fails when one falls under an exclusion. A test that reads a file through a
path it builds at runtime is invisible to that scan, so name it literally or
drop the exclusion.

Reading the cache: every cached job's step summary has one line per target,
and the `test-cache` job summarises the hit rate, the targets served from the
cache, the time saved and the time executed. Each record (hash, hit, duration)
is uploaded as the `test-cache-<target>` artifact.

Suspected stale hit: compare the hash in the summary with
`bunx turbo run ci:unit --dry=json --env-mode=loose --dangerously-disable-package-manager-check`
(substitute the target's task and set the job's env vars). The output lists
every hashed file and env var; a file the target reads but that is missing
there means the task's inputs are too narrow. To bypass the cache, dispatch CI
manually with `test_cache` unticked, or set the repository variable
`TEST_CACHE=off` to disable reads everywhere until it is removed. Locally, run
the suite directly (`bun run test`, `cargo test`), which never uses the cache.
