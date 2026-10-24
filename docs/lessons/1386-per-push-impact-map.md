# #1386 — per-dev-push E2E impact map

- **Block coverage is the expensive part, not coverage itself.** CDP precise
  coverage with `callCount:false, detailed:false` (function granularity) costs
  about 5% on the bundle; block coverage on the dev server is what made the
  nightly run slow. Function granularity is enough for method-level selection.
- **A bundle chunk is not one module.** Rollup concatenates modules and drops
  CSS and fully tree-shaken modules from the source map, so the map alone
  under-reports what a test loaded. The build emits `e2e-chunk-modules.json`
  (from `chunk.modules`), and an evaluated chunk marks every listed module
  loaded. Under-reporting a loader would silently under-select a PR.
- **Map commit must equal coverage commit.** `e2e-impact-map.yml` checked out
  `dev` for its merge job, so a push landing mid-run stamped the map with a
  newer commit than the shards had run (`ae3db5a` vs `57b34ca9`), hiding the
  drift between them. Check out `github.sha` in every job and pass
  `--commit $GITHUB_SHA` to the merge.
- **Partial maps must not publish.** A shard replayed from the test-result
  cache records no coverage; merging the other shards would yield a map that
  looks complete but misses those specs' tests. The merge job counts reports
  against `EXPECTED_REPORTS` and publishes nothing otherwise.
- **Trust the producing run, not the artifact name.** Any workflow run can
  upload `e2e-impact-map`; `scripts/impact-map-source.mjs` checks the run's
  event, workflow path, branch and repository.
