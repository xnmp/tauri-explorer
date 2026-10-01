import { describe, expect, it, vi } from "vitest";
import type { FileMutationReceipt } from "$lib/domain/file";
import type { HistoryReply, HistorySummary, UndoAction } from "$lib/domain/file-history";
import type { CopySessionOutcome } from "$lib/domain/copy-session";
import { decodeDirectoryListing, type CompactDirectoryListing } from "$lib/api/directory-wire";

vi.stubGlobal("window", {} as Window & typeof globalThis);
const { mockInvoke } = await import("$lib/api/mock-invoke");

describe("mock move history execution", () => {
  it("keeps an inverse move's reserved transition, then invalidates redo on a forward move", async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const sourceDir = `/home/user/mock-move-source-${suffix}`;
    const destDir = `/home/user/mock-move-dest-${suffix}`;
    const otherSource = `/home/user/mock-forward-source-${suffix}`;
    const otherDest = `/home/user/mock-forward-dest-${suffix}`;
    await mockInvoke<FileMutationReceipt>("create_directory", { parentPath: "/home/user", name: sourceDir.split("/").pop() });
    await mockInvoke<FileMutationReceipt>("create_directory", { parentPath: "/home/user", name: destDir.split("/").pop() });
    await mockInvoke<FileMutationReceipt>("create_directory", { parentPath: "/home/user", name: otherSource.split("/").pop() });
    await mockInvoke<FileMutationReceipt>("create_directory", { parentPath: "/home/user", name: otherDest.split("/").pop() });
    await mockInvoke<FileMutationReceipt>("write_text_file", { path: `${destDir}/a.txt`, content: "x" });
    await mockInvoke<FileMutationReceipt>("write_text_file", { path: `${otherSource}/b.txt`, content: "x" });

    const action: UndoAction = {
      type: "move", sourcePath: `${sourceDir}/a.txt`, destPath: `${destDir}/a.txt`, originalDir: sourceDir,
    };
    const pushed = await mockInvoke<HistoryReply>("file_history_push", { action });
    const result = await mockInvoke<HistoryReply>("file_history_execute", {
      direction: "undo", expectedEntryId: pushed.summary.undoId,
    });

    expect(result.error).toBeUndefined();
    expect(result.summary.undoId).toBeNull();
    expect(result.summary.redoId).not.toBeNull();
    const sourceListing = decodeDirectoryListing(await mockInvoke<CompactDirectoryListing>("list_directory", { path: sourceDir }));
    expect(sourceListing.entries.map(({ path }) => path)).toContain(`${sourceDir}/a.txt`);

    // Forward moves have no standalone `move_entry` command (#881); the
    // production path is the ordered `move_entries` session, which is what
    // must invalidate the redo entry the undo above reserved.
    const sessionReply = await mockInvoke<{ result: CopySessionOutcome; history: HistorySummary }>("move_entries", {
      request: { requestId: `mock-forward-${suffix}`, sources: [`${otherSource}/b.txt`], destDir: otherDest },
      events: () => {},
    });
    expect(sessionReply.result.items).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(sessionReply.history.redoId).toBeNull();
  });
});
