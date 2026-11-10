#!/usr/bin/env bash
# ci-test-unit.sh — ci.yml's unit-test target, run through the test-result
# cache (scripts/test-cache.mjs ci:unit, #1176). UNIT_SELECTION comes from
# scripts/unit-affected.mjs: ALL, NONE or the inputs for `vitest related`.
set -euo pipefail
case "${UNIT_SELECTION:?}" in
  ALL)
    bun run test ;;
  NONE) ;;
  *)
    read -ra inputs <<< "$UNIT_SELECTION"
    bunx vitest related --run --passWithNoTests "${inputs[@]}"
    bunx vitest related --run --passWithNoTests -c vitest.perf.config.ts "${inputs[@]}" ;;
esac
