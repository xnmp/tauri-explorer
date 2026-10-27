#!/usr/bin/env bash
# ci-test-e2e.sh — one ci.yml browser shard, run through the test-result cache
# (scripts/test-cache.mjs ci:e2e, #1176). E2E_SHARD_SPECS is the shard's
# newline-separated spec list from scripts/e2e-shards.mjs plan, so the cache
# hash covers exactly the specs that run.
set -euo pipefail
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
printf '%s\n' "${E2E_SHARD_SPECS:?}" > "$list"
# Fails unless Playwright selects exactly the planned files; --test-list
# silently runs nothing for an unresolvable entry.
node scripts/e2e-shards.mjs verify --engine "${E2E_ENGINE:?}" --list "$list"
# A stalled shard stops itself below the CI step and job caps (#1367), so the
# line reporter prints its interrupted and unrun tests and the HTML report is
# written, instead of the runner killing the job with no diagnosis.
limit=()
if [ -n "${E2E_GLOBAL_TIMEOUT_MINUTES:-}" ]; then
  limit=("--global-timeout=$((E2E_GLOBAL_TIMEOUT_MINUTES * 60000))")
fi
# The timing reporter prints each test attempt's duration for the weekly
# shard-timings refresh (scripts/e2e-shards.mjs record), which cannot read
# durations from interleaved start lines when a job runs several workers.
reporter=line,html,./scripts/e2e-timing-reporter.mjs
# Coverage runs for the impact map (#1386) also write the JSON report the
# merge needs to tell an unrecorded test from one that never ran.
if [ -n "${E2E_COVERAGE:-}" ] && [ -n "${PLAYWRIGHT_JSON_OUTPUT_FILE:-}" ]; then
  reporter="$reporter,json"
fi
case "$E2E_ENGINE" in
  chromium)
    npx playwright test --project=chromium --test-list "$list" --reporter="$reporter" "${limit[@]}" ;;
  webkit)
    # Only video decoder specs opt into GTK; other specs retain headless WPE.
    # The display belongs to this hosted runner and is destroyed after testing.
    xvfb-run -a --server-args="-screen 0 1920x1080x24 -nolisten tcp" \
      npx playwright test --project=webkit --test-list "$list" --reporter="$reporter" "${limit[@]}" ;;
  *)
    echo "ci-test-e2e: unknown engine $E2E_ENGINE" >&2
    exit 2 ;;
esac
