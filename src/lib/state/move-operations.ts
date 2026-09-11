/**
 * Ordered native move sessions for cut/paste and drag-and-drop.
 *
 * The renderer records no inverse. Native history already holds one entry for
 * the whole session, and a durable move's inverse is its recovery record —
 * replaying a path-only move can relocate whatever now sits at the
 * destination, which for a cross-filesystem move is the last copy of the data.
 */
import { moveEntries } from "$lib/api/move-session";
import { parentDir } from "$lib/domain/path";
import { moveSessionError } from "$lib/domain/copy-session";
import { runSession, type SessionContext, type SessionResult } from "./session-operations";

export type MoveContext = SessionContext;
export type MoveResult = SessionResult;

export async function moveFiles(
  sources: readonly string[], destination: string, context: MoveContext,
): Promise<MoveResult> {
  return runSession({
    operation: "move",
    past: "Moved",
    run: moveEntries,
    describe: moveSessionError,
    // A relocation empties its source directory, which no destination receipt
    // names. Without this the vacated pane keeps showing the moved entry.
    vacated: (sources) => sources.map((source) => parentDir(source)),
  }, sources, destination, context);
}
