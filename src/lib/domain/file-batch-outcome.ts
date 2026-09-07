/** Confirmed per-path results of best-effort filesystem work. */
export interface FileBatchOutcome {
  succeeded: string[];
  failed: { path: string; error: string }[];
}

/** Port result: transport/admission failure is distinct from per-item failure. */
export type FileBatchResult =
  | { ok: true; data: FileBatchOutcome }
  | { ok: false; error: string };

export function fileBatchError(outcome: FileBatchOutcome): string | null {
  return outcome.failed.length
    ? outcome.failed.map(({ path, error }) => `${path}: ${error}`).join("; ")
    : null;
}
