import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileMutationReceipt } from "$lib/domain/file";
import type { HistorySummary } from "$lib/domain/file-history";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSession: vi.fn(async () => "session-23"),
  receiveSummary: vi.fn(),
}));

vi.mock("$lib/api/common", async (original) => ({
  ...await original<typeof import("$lib/api/common")>(),
  invoke: mocks.invoke,
}));
vi.mock("$lib/api/native-resource-session", () => ({
  getNativeResourceSession: mocks.getSession,
  receiveHistorySummary: mocks.receiveSummary,
}));

import { moveEntry } from "$lib/api/files";

const history = (revision: number): HistorySummary => ({
  revision, undoId: null, redoId: 9, stackSize: 0, busy: false,
});

beforeEach(() => vi.clearAllMocks());

describe("moveEntry native admission", () => {
  it("sends the acknowledged session and preserves the settled receipt, warning, and history", async () => {
    const receipt: FileMutationReceipt = {
      path: "/dest/a.txt",
      entry: null,
      recovery: {
        sourcePath: "/source/a.txt",
        destinationPath: "/dest/a.txt",
        error: "Source cleanup needs recovery",
      },
    };
    const summary = history(4);
    mocks.invoke.mockResolvedValue({ result: receipt, history: summary, warning: "History retention is unavailable" });

    await expect(moveEntry("/source/a.txt", "/dest", true)).resolves.toEqual({
      ok: true, data: receipt, warning: "History retention is unavailable",
    });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("move_entry", {
      source: "/source/a.txt", destDir: "/dest", overwrite: true, sessionId: "session-23",
    });
    expect(mocks.receiveSummary).toHaveBeenCalledExactlyOnceWith(summary);
  });

  it("returns rejected native admission as failure without consuming a history summary", async () => {
    mocks.invoke.mockRejectedValue({ kind: "other", message: "File history changed before admission" });
    await expect(moveEntry("/source/a.txt", "/dest")).resolves.toEqual({
      ok: false, error: "File history changed before admission",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("move_entry", expect.objectContaining({ sessionId: "session-23" }));
    expect(mocks.receiveSummary).not.toHaveBeenCalled();
  });
});
