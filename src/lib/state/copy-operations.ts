/** Ordered native copy sessions for paste and drop. History stays native-owned. */
import { copyEntries } from "$lib/api/copy-session";
import { copySessionError } from "$lib/domain/copy-session";
import { runSession, type SessionContext } from "./session-operations";

export type CopyContext = SessionContext;

export async function copyFiles(
  sources: readonly string[], destination: string, context: CopyContext,
): Promise<string | null> {
  const { error } = await runSession({
    operation: "copy",
    past: "Copied",
    run: copyEntries,
    describe: copySessionError,
    // A copy leaves its source directory unchanged.
    vacated: () => [],
  }, sources, destination, context);
  return error;
}
