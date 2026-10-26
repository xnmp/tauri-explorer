/**
 * Unit files whose unchanged deadlines are sensitive to scheduler contention
 * (#1123): the 5,001-activation registry churn (no timing assertion, but
 * competing transforms can exhaust its five-second deadline) and the
 * graph-lineage file's wall-clock hover budget. vitest.config.ts excludes
 * them and vitest.perf.config.ts runs them one file at a time, after the
 * parallel unit suite (`bun run test`, scripts/ci-test-unit.sh).
 */
export const SERIAL_UNIT_FILES = [
  "tests/plugins/registry-churn.test.ts",
  "tests/domain/git-graph-branch-line.test.ts",
];
