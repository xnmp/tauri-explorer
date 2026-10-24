// e2e-timing-reporter.mjs — one log line per finished test attempt, for
// `scripts/e2e-shards.mjs record` (#1368).
//
// With several Playwright workers per CI job, test-start lines interleave, so
// the gap between them is no test's duration. This prints each attempt's own
// duration instead:
//   [e2e-timing] <project> <spec path relative to the project's testDir> <seconds>
// It prints nothing else and leaves the console to the line reporter.

import { relative, sep } from "node:path";

export const TIMING_PREFIX = "[e2e-timing]";

/**
 * @param {string} project
 * @param {string} testDir
 * @param {string} file absolute spec path
 * @param {number} durationMs
 */
export function timingLine(project, testDir, file, durationMs) {
  const spec = relative(testDir, file).split(sep).join("/");
  return `${TIMING_PREFIX} ${project} ${spec} ${(Math.max(0, durationMs) / 1000).toFixed(2)}`;
}

export default class TimingReporter {
  /**
   * @param {import("@playwright/test/reporter").TestCase} test
   * @param {import("@playwright/test/reporter").TestResult} result
   */
  onTestEnd(test, result) {
    const project = test.parent.project();
    if (!project) return;
    process.stdout.write(`${timingLine(project.name, project.testDir, test.location.file, result.duration)}\n`);
  }

  printsToStdio() {
    return false;
  }
}
