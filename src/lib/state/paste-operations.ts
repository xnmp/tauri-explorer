/**
 * Paste dispatch for both clipboard modes.
 *
 * Copies and cuts are both ordered native sessions now: one history
 * reservation covers the whole selection, the native side owns conflict
 * pauses and cancellation, and the completed prefix survives either. The
 * renderer records no inverse of its own — a durable move's inverse is its
 * recovery record, and a path-only move can relocate whatever now happens to
 * sit at the destination.
 */

import type { FileEntry } from "$lib/domain/file";

export interface PasteSource {
  path: string;
  name: string;
  size?: number;
  modified?: string;
}

export interface PasteContext {
  destPath: string;
  existingEntries: FileEntry[];
  onEntriesAdded: (entries: FileEntry[]) => void;
  onRefresh: () => Promise<unknown>;
}

export interface PasteResult {
  error: string | null;
  timestamp: number;
}

export async function pasteEntries(
  sources: PasteSource[],
  isCut: boolean,
  context: PasteContext,
  onComplete?: () => void,
): Promise<string | null> {
  const paths = sources.map((source) => source.path);
  if (!isCut) {
    const { copyFiles } = await import("./copy-operations");
    const result = await copyFiles(paths, context.destPath, context);
    onComplete?.();
    return result;
  }
  const { moveFiles } = await import("./move-operations");
  const { error, complete } = await moveFiles(paths, context.destPath, context);
  // The caller clears a cut clipboard on completion. Keep it intact unless
  // every source actually reached the destination, so the UI never claims a
  // partially cancelled or failed cut completed.
  if (complete) onComplete?.();
  return error;
}
