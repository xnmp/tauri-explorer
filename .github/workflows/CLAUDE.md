# CI trigger policy

Only `ci.yml` and the Linux matrix entry in `e2e-tauri.yml` run on PRs into
dev; PRs into main run only `release-gate.yml`.
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

PRs into `main` run no CI (#1367): their code already passed its dev push.
`release.yml`'s `dev-ci-gate` (`scripts/release-ci-gate.mjs`) refuses to
tag or build unless a dev commit with the released commit's exact
tree has a successful dev-push `ci.yml` run and `smoke (ubuntu-latest)`. Merge
to main only after dev CI for that tree is green (the gate waits up to an hour
for a run in progress); a commit made directly on main cannot be released.
The gate runs only when a release would happen (the version is not yet
tagged), and retries transient API 5xx responses before failing closed.
`release-gate.yml` runs the same gate on PRs into main as the `release-gate`
check, against the PR's merge commit (the tree a merge commit will release).
A workflow cannot make it required: an admin adds `release-gate` as a required
check on the "Main branch" ruleset.
Pushes to main still run `ci.yml`. `ci.yml` also runs nightly (`schedule`,
default branch dev) with the test-result cache bypassed.

`ci-auto-rerun.yml` (`workflow_run`, so the default-branch copy runs) re-runs a
failed first attempt's failed jobs once, only when every failed non-gate job
stopped at an install/setup step (`SETUP_STEP` in `scripts/ci-jobs.mjs`). Gate
jobs print each upstream shard's result and failing step first; the report is
`continue-on-error` and never decides the gate. A pull_request run is re-run
only while it is the newest run of its workflow for the branch and the open
PR's head is still its `head_sha` (`staleRunReason`): a re-run joins the PR's
cancel-in-progress group and would otherwise cancel the newer run.

`e2e-shard-timings.yml` (weekly) pushes nothing: the repository does not let
GITHUB_TOKEN open PRs. It uploads the regenerated timings as the
`e2e-shard-timings` artifact and writes the drift to the job summary; apply it
in an ordinary PR. It fails with an error when no successful dev run exists.

# Browser jobs in the Playwright container (#1367)

`chromium`, `chromium-view-modes` and `webkit-tests` run in
`mcr.microsoft.com/playwright:v<version>-noble@sha256:<digest>`, whose tag must
equal bun.lock's `@playwright/test` (`tests/ci-playwright-container.test.ts`).
Bumping Playwright means bumping the three `container.image` references, plus
`e2e-impact-map.yml`'s coverage job (tag
and digest, from `docker buildx imagetools inspect`) and `ImageVersion`
(`<version>_<digest hex>`, the cache identity) in the same PR. The image has browsers, GStreamer, fonts and xvfb but no
unzip, jq or gh: bun comes from the `@oven/bun-linux-x64` npm package at
`CONTAINER_BUN_VERSION` (ci.yml's workflow env, the single pin; e2e-impact-map.yml repeats it and a test keeps them equal), installed with
`--ignore-scripts` and checked with `bun --version` (setup-bun needs unzip), the test cache extracts artifacts with `python3 -m zipfile`, and paths
an action reads must come from `$RUNNER_TEMP` inside the container (exported
to `GITHUB_ENV`), not `${{ runner.temp }}`, which names the host path. Git
needs `safe.directory` because the container runs as root.
`ImageOS`/`ImageVersion` are set to the container so cached results are scoped
to it. Each shard bounds Playwright with `E2E_GLOBAL_TIMEOUT_MINUTES`, below
the step `timeout-minutes`, below the job cap.

# PR test selection (#1175)

On `pull_request`, ci.yml's `changes` job narrows each tier from the PR merge
diff (`HEAD^1...HEAD`) and nothing else: `scripts/e2e-affected.mjs` (browser
specs), `scripts/unit-affected.mjs` (`vitest related` inputs) and
`scripts/rust-affected.mjs` (`cargo test -p` members via `cargo metadata`).
Each publishes `ALL`, `NONE` or a list plus a reason, and every test step logs
which it ran and why. Browser selection is per engine (#1367); with a test-impact map the three
tiers select by coverage instead (#1368, below). Without one: `e2e`
(`--strict`, Chromium: every spec for any `src/` change), `webkit` (`--webkit`:
the Chromium selection when narrow, else cluster-mapped plus the curated
`browserName`/`@webkit` specs, or ALL for a `WEBKIT_SENSITIVE` path, component
styling, or anything the clusters cannot place) and `view-modes`
(`--view-modes`: specs iterating `VIEW_MODES` reached through a view-mode
component or spec, run with `ALL_VIEW_MODES=1`; ALL = every such spec, also
selected by stylesheets, themes and global markup). A
browser job whose selection is `NONE` is skipped and its gate accepts that
only for `NONE`. A version-only diff (`scripts/version-only.mjs`) selects e2e
NONE, rust NONE and only the unit tests that read the bumped files.
`map-feature.md` changes select the union of the base and head maps. Pushes and manual runs always use `ALL`. Any doubt is
`ALL` for that tier: a selector failure, an unknown file type, an unusual path,
or more than `TEST_SELECTION_MAX_FILES` (50, set on the `changes` job) changed
files. A Rust `NONE` also skips the toolchain, fmt and clippy steps; the
dorny/paths-filter docs-only gate runs first. It treats only `docs/**`,
root-level `*.md`, `output/**`, `screenshots/**` and `evidence/**` as
documentation: Markdown under `e2e/`, `src/`, `tests/` or elsewhere can be a
fixture or text contract and counts as code.

`vitest related` follows imports only. Tests that read files as text are found
by the selector's text scan (path or basename, or the directory for tests that
list directories); a test reading a path it builds dynamically from neither is
invisible to it, so name such inputs literally. Rust inputs outside `src-tauri/`
count only when a string literal ends in their basename (`include_bytes!`,
fixture joins), not when a comment mentions them.

# E2E test-impact map (#1368)

`e2e-impact-map.yml` (nightly on dev, and manual dispatch) runs every Chromium
spec with `E2E_COVERAGE=1 ALL_VIEW_MODES=1` in six shards and merges the
per-test V8 coverage records into the `e2e-impact-map` artifact (14 days).
Test failures do not fail the coverage job; a spec with an executed test that
left no record is marked incomplete, and PR selection always runs it. The map
is never committed.

On PRs the `changes` job installs dependencies with `--ignore-scripts`
(TypeScript proves comment/type-only hunks inert), downloads the newest map
from a successful dev run, fetches the map's commit (`--depth=1`) for line
translation, and passes `--impact-map=` to the three browser selectors. Each
step is `continue-on-error`: no map, a failed download, a malformed map or one
older than `MAX_MAP_AGE_HOURS` (72) selects exactly as before the map existed.
With a map, Chromium runs the specs whose tests executed the changed lines
(`scripts/impact-select.mjs`), plus the drift: tests that executed code
changed between the map's commit and the merge base, and specs edited since
then, because their coverage in the map is out of date (an unavailable map
commit means no map). WebKit is the selection without a map united with the
coverage and curated engine-specific specs (Chromium coverage cannot see a
WebKit-only caller), and still runs in full for `WEBKIT_SENSITIVE` paths,
component styling, engine detection or a change no Chromium test executed;
view modes keep the view-mode specs among the Chromium selection. A new file,
a file no spec loaded, an asset no spec fetched, the mock backend, config,
lockfiles, selection inputs and the map's recorder (`impact-collect.mjs`,
`impact-lines.mjs`, `e2e/impact-coverage.ts`, this workflow) still select ALL.
Dev pushes, the nightly CI run and dispatch still run every spec.

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
The browser target hashes the root `package.json` with its version replaced
by a placeholder (`TEST_CACHE_NORMALIZE_VERSION=1` on the browser jobs
rewrites the checkout's copy before any hash), so a release bump replays
browser shards; `PKGBUILD` is excluded from its inputs.
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

Trust: GitHub's artifact service, rather than a workflow boolean or an
outside-checkout directory, enforces ownership. Only `ci.yml` push
attempts on protected `dev` in this repository are eligible producers. Each
artifact carries a target-specific passing result, checked before replay. Restore
queries those runs and downloads an artifact by its API ID from that run;
PRs cannot create artifacts in a dev run with their runtime credentials.
Even if a PR enables saving or uploads a matching name, its artifacts never
enter the eligible producer set. Same-repo PRs are also read-only: permitting
their writes safely would require a protected producer outside PR code.
Do not switch back to `actions/cache` prefix restore: a PR can shadow a dev
key with a forged pass in its own merge-ref cache on a later run.

Artifacts use `trusted-test-cache-v3-<os>-<arch>-<image>-<image version>-<target>-<run>-<attempt>`.
Restore computes the requested target's hash with Turborepo, then searches
artifacts across the latest 30 dev pushes plus the current rerun if older.
`UNIT_SELECTION` is job-wide so restore and execution hash the same selection;
browser shard selection and Rust feature/selection variables are also available
before restore. Keep these environments aligned.

A run becomes queued/in progress again during reruns, so verify the producing
attempt's provenance through GitHub's workflow-attempt API rather than filtering
by current conclusion. Completed attempts may have unrelated failed jobs: accept
the target's own `result.json` proof of a newly passing execution, not an overall
workflow-success requirement. `pack` refuses failed, cached or read-only results
and includes only that result's cache entry in `entries.tar`. GitHub's run-owned
artifact service is the authorization boundary for this record; PR artifacts
remain ineligible regardless of their contents or name.

Restore keeps looking across artifacts and attempts until the record's target,
task and hash match the request and its unexpired cache entry is present. A
newer archive for another hash cannot hide an older match, even when concurrent
dev runs restored the same initial cache. Invalid records and unavailable or
expired entries are misses. The v3 schema deliberately ignores older artifacts
without a per-target pass record; the first dev production starts cold.
PR-specific inputs with no dev-produced result run normally on every attempt;
this trades cache hit rate for an enforceable write boundary without new secrets
or repository administration. The local Turborepo directory remains outside
the checkout to ignore committed cache files.

Each saved artifact contains `result.json` and `entries.tar` to preserve entry creation times
through zip transport. Entries expire 30 days after creation, including on
read-only runs. Prune before the probe so an expired hit cannot skip setup;
`GITHUB_ENV` carries `TEST_CACHE_PROBED_AT` into execution so crossing the TTL
between probe and run cannot invalidate a hit after dependencies were skipped.
The artifact retention is also 30 days. Keep cache data names outside the
`test-cache-*` report-artifact pattern.

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
