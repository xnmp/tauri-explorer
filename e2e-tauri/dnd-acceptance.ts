/** Required real-input contracts, independent of Mocha discovery and test counts. */
export const requiredDndContracts = [
  "listing-move-details", "listing-move-list", "listing-move-tiles",
  "miller-move", "miller-copy", "miller-copy-after-start", "cancel-retry",
] as const;

export const dndSuite = "file drag against the real GTK backend";

type Outcome = Record<string, unknown>;
const record = (value: unknown): value is Outcome => value !== null && typeof value === "object";

export function assessDndNegativeControl(
  outcomes: readonly unknown[], runId: string, exitCode: number | null, suppressed: boolean,
): { passed: boolean; errors: string[]; completed: string[] } {
  const rows = outcomes.filter(record).filter(value => value.qualificationRunId === runId);
  const intendedFailure = rows.length === 1 && rows[0].suite === dndSuite
    && typeof rows[0].title === "string" && rows[0].title.startsWith("[dnd:listing-move-details] ")
    && rows[0].passed === false && rows[0].skipped === false
    && typeof rows[0].error === "string" && rows[0].error.includes("drop highlighted its folder but did not move the file");
  const passed = !!runId && suppressed && exitCode === 1 && intendedFailure;
  return {
    passed, errors: passed ? [] : ["Negative control did not observe an admitted native drag failing its filesystem outcome after suppressed GTK acknowledgement"],
    completed: passed ? ["suppressed-gtk-acknowledgement"] : [],
  };
}

export function assessDndAcceptance(
  outcomes: readonly unknown[], runId: string, exitCode: number | null,
): { passed: boolean; errors: string[]; completed: string[] } {
  const errors: string[] = [];
  const completed: string[] = [];
  if (exitCode !== 0) errors.push(`Native runner failed (exit ${exitCode})`);
  if (!runId) errors.push("Missing qualification run identity");
  const rows = outcomes.filter(record).filter(value => value.qualificationRunId === runId);
  if (rows.some(value => (value.passed === false && value.skipped !== true) || value.error != null)) {
    errors.push("This invocation contains a failed native outcome");
  }
  for (const contract of requiredDndContracts) {
    const matches = rows.filter(value => value.suite === dndSuite
      && typeof value.title === "string" && value.title.startsWith(`[dnd:${contract}] `));
    if (matches.length !== 1) {
      errors.push(`${contract}: expected one outcome from this run, received ${matches.length}`);
    } else if (matches[0].passed !== true || matches[0].skipped !== false || matches[0].error != null) {
      errors.push(`${contract}: did not pass without skipping`);
    } else {
      completed.push(contract);
    }
  }
  return { passed: errors.length === 0, errors, completed };
}
