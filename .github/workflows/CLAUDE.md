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
git-tracked file minus the task's `!` exclusions), the root `package.json` and
`bun.lock` (always, for every task), the task definition, and the env vars it
lists: the selection (`UNIT_SELECTION`, `RUST_SELECTION`, the shard's
`E2E_SHARD_SPECS`), feature flags, `RUNNER_OS`, `RUNNER_ARCH`, `ImageOS`,
`ImageVersion` and `TEST_CACHE_TOOLCHAIN` (bun/node, or rustc/cargo plus the
apt candidate versions of `TEST_CACHE_APT_PACKAGES`). An unchanged hash
replays the passing log and reports `<target>: passed from the test-result
cache`. Turborepo never stores a failed task, so a failure always re-runs.
Browser and Rust jobs probe first and skip browser, apt and build-cache setup
on a hit; the Rust job installs bun dependencies only to get Turborepo.

Inputs stay `$TURBO_DEFAULT$` plus exclusions: explicit include globs also hash
git-ignored files such as `src-tauri/target`, which rust-cache restores between
the probe and the run. The unit target reads ADRs, the README, workflows,
`website/api` and Rust sources as text contracts, so those are its inputs; the
Rust target excludes the frontend, browser specs, docs and the website; the
browser target excludes Rust, the website, docs, workflows and unit tests.
Environment that is neither a file nor a listed env var (Playwright's apt
dependencies, the `python3`/`rustc` some unit tests call) is covered only by
`ImageVersion`.

Each exclusion must cover only files the target never reads.
`tests/test-cache.test.ts` asks Turborepo which files each target hashes and
fails when a file named in a reader's string literal, or a listed lockfile,
config or runner script, is missing; its scratch-repository tests check that
changing each dependency re-runs the target. A test that reads a file through
a path built at runtime is invisible to the scan, so name it literally or drop
the exclusion.

Trust: the cache directory is `$RUNNER_TEMP/turbo-test-cache`, outside the
checkout (the script refuses a path inside it), so files a PR commits can
never be read as entries. `actions/cache/restore` and `actions/cache/save` are
split, and the save runs only when `TEST_CACHE_WRITE` is true (dev pushes and
same-repo PRs) and the run stored a new result. Fork PRs, main pushes and
manual runs read only (`--cache=local:r`); local machines have no access to the
CI cache. GitHub scopes a PR's cache entries to that PR's merge ref, so even a
PR that edits this workflow cannot write an entry that dev or another PR reads.
Keys are `test-cache-v1-<os>-<arch>-<image>-<image version>-<target>-<run>`, so
a Linux result can never satisfy a Windows or macOS job. Trusted runs drop
entries older than 30 days before saving.

Reading the cache: every cached job's step summary has one line per target,
and the `test-cache` job summarises the hit rate, the targets served from the
cache, the time saved and the time executed. Each record (hash, hit, duration)
is uploaded as the `test-cache-<target>` artifact.

Suspected stale hit: check out the commit and run
`node scripts/test-cache.mjs explain --task ci:<target>` with the job's env
(`UNIT_SELECTION`, `RUST_*`, `E2E_ENGINE`/`E2E_SHARD_SPECS`, and the
`RUNNER_*`/`Image*` values from the job log). It prints the hash, the toolchain
fingerprint, and every hashed file and env var, computed exactly as CI does; a
file the target reads but that is missing there means the task's inputs are too
narrow. Fix `turbo.json` (the changed task definition invalidates that task),
or bump `CACHE_VERSION` in the script to discard every entry.

Bypassing: dispatch CI manually with `test_cache` unticked to re-run every
target once. That run is read-only, so it does not replace a stale entry. Set
the repository variable `TEST_CACHE=off` to stop reads everywhere; dev pushes
then re-run every target and store fresh results, which replaces stale
entries. Remove the variable afterwards. Locally, run the suite directly
(`bun run test`, `cargo test`); that never uses the cache.
