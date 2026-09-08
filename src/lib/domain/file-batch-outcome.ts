/** Confirmed per-path results of best-effort filesystem work. */
export interface FileBatchOutcome {
  succeeded: string[];
  failed: { path: string; error: string }[];
  uncertain?: { path: string; error: string }[];
  unstarted?: string[];
  warnings?: { path: string; error: string }[];
  /** Failure outside an active item, such as final worker cleanup. */
  workerError?: string;
}

/** Port result: transport/admission failure is distinct from per-item failure. */
export type FileBatchResult =
  | { ok: true; data: FileBatchOutcome }
  | { ok: false; error: string };

export function fileBatchError(outcome: FileBatchOutcome): string | null {
  const errors = outcome.failed.map(({ path, error }) => `${path}: ${error}`);
  errors.push(...(outcome.uncertain ?? []).map(({ path, error }) => `${path}: outcome is uncertain; inspect the affected files before continuing: ${error}`));
  errors.push(...(outcome.warnings ?? []).map(({ path, error }) => `${path}: ${error}`));
  if (outcome.workerError !== undefined) errors.push(`File worker did not finish cleanly; inspect the affected files before continuing: ${outcome.workerError}`);
  if (outcome.unstarted?.length) errors.push(`${outcome.unstarted.length} items were not started`);
  return errors.length ? errors.join("; ") : null;
}

export function affectedBatchPaths(outcome: FileBatchOutcome): string[] {
  return [
    ...outcome.succeeded,
    ...(outcome.uncertain ?? []).map(({ path }) => path),
    ...(outcome.workerError !== undefined
      ? [...outcome.failed.map(({ path }) => path), ...(outcome.unstarted ?? [])]
      : []),
  ];
}
