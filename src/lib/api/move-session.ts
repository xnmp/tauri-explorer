/** One ordered native move request. Its inverse is native-owned: the reply's
 *  history summary already records the completed prefix, so the renderer must
 *  never push its own undo action for a session item. */
import type { CopySessionOutcome } from "$lib/domain/copy-session";
import { runOrderedSession, type SessionOptions } from "./copy-session";
import type { ApiResult } from "./common";

export type MoveEntriesOptions = SessionOptions;

export async function moveEntries(
  sources: readonly string[],
  destDir: string,
  options: SessionOptions,
): Promise<ApiResult<CopySessionOutcome>> {
  return runOrderedSession("move_entries", sources, destDir, options);
}
