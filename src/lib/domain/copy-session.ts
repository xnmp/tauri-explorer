/** One ordered native copy request. Item position remains stable for duplicates. */
import type { FileEntry, FileMutationReceipt } from "./file";
import { basename } from "./path";

export interface CopyConflict {
  fileName: string;
  sourcePath: string;
  remaining: number;
  sourceSize: number;
  sourceModified: string;
  destSize: number;
  destModified: string;
}

export interface CopyDecision {
  choice: "overwrite" | "skip" | "cancel";
  applyToAll: boolean;
}

export type CopySessionEvent =
  | { type: "ready" }
  | { type: "conflict"; item: number; nonce: string; conflict: CopyConflict }
  | { type: "started"; item: number; total: number }
  | { type: "progress"; item: number; progress: { jobId: number; bytesDone: number; bytesTotal: number; currentFile: string } }
  | { type: "completed"; item: number; total: number; entry: FileEntry | null };

export type CopyItemOutcome =
  | { status: "succeeded"; receipt: FileMutationReceipt }
  | { status: "skipped" }
  | { status: "unstarted" }
  | { status: "failed"; error: string }
  | { status: "uncertain"; error: string };

export interface CopySessionOutcome {
  items: CopyItemOutcome[];
  cancelled: boolean;
  warnings: string[];
}

/** Bound presentation independently of the native positional receipt ledger.
 *  A cancelled session reports its unstarted tail as neither failure nor
 *  warning: the completed prefix is the whole of what the user asked for. */
function sessionError(
  sources: readonly string[],
  outcome: CopySessionOutcome,
  verb: "Copy" | "Move",
  cancelled: string,
): string | null {
  const messages: string[] = [];
  let failed = 0;
  for (const [index, item] of outcome.items.entries()) {
    if (item.status === "succeeded" || item.status === "skipped") continue;
    if (outcome.cancelled && (item.status === "unstarted" || (item.status === "failed" && item.error === cancelled))) continue;
    failed++;
    if (messages.length >= 20) continue;
    const detail = item.status === "unstarted" ? `${verb} did not start`
      : item.error || `See the ${verb.toLowerCase()} diagnostics for this incomplete item`;
    messages.push(`${basename(sources[index])}: ${detail}`);
  }
  if (failed > messages.length) messages.push(`${failed - messages.length} additional items could not be ${verb === "Copy" ? "copied" : "moved"}`);
  return failed ? `${verb} incomplete: ${messages.join("\n")}` : null;
}

export function copySessionError(sources: readonly string[], outcome: CopySessionOutcome): string | null {
  return sessionError(sources, outcome, "Copy", "Copy cancelled");
}

export function moveSessionError(sources: readonly string[], outcome: CopySessionOutcome): string | null {
  return sessionError(sources, outcome, "Move", "Move cancelled");
}
