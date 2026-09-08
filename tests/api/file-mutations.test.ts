import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileMutationReceipt } from "$lib/domain/file";
import type { FileBatchOutcome } from "$lib/domain/file-batch-outcome";
import type { HistorySummary } from "$lib/domain/file-history";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSession: vi.fn(),
  receiveSummary: vi.fn(),
}));

vi.mock("$lib/api/common", () => ({
  invoke: mocks.invoke,
  extractError: (error: unknown) => {
    if (typeof error === "object" && error !== null && "message" in error) {
      return String((error as { message: unknown }).message);
    }
    return String(error);
  },
}));

vi.mock("$lib/api/native-resource-session", () => ({
  getNativeResourceSession: mocks.getSession,
  receiveHistorySummary: mocks.receiveSummary,
}));

import { invokeFileMutation } from "$lib/api/file-mutations";

const history = (revision: number): HistorySummary => ({
  revision,
  undoId: revision,
  redoId: null,
  stackSize: 1,
  busy: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue("session-17");
});

describe("invokeFileMutation", () => {
  it("sends the original command context with the acknowledged renderer session", async () => {
    const summary = history(4);
    const receipt = { path: "/docs/new", entry: null };
    mocks.invoke.mockResolvedValue({ result: receipt, history: summary });

    await expect(invokeFileMutation<FileMutationReceipt>("create_directory", {
      parentPath: "/docs",
      name: "new",
    })).resolves.toEqual({ ok: true, data: receipt });

    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("create_directory", {
      parentPath: "/docs",
      name: "new",
      sessionId: "session-17",
    });
    expect(mocks.receiveSummary).toHaveBeenCalledExactlyOnceWith(summary);
  });

  it("consumes the native history revision before resolving the committed receipt", async () => {
    const events: string[] = [];
    const summary = history(8);
    mocks.invoke.mockResolvedValue({
      result: { path: "/docs/renamed.txt", entry: null },
      history: summary,
    });
    mocks.receiveSummary.mockImplementation(() => { events.push("summary"); });

    const result = await invokeFileMutation<FileMutationReceipt>("rename_entry", {
      path: "/docs/old.txt",
      newName: "renamed.txt",
    }).then((value) => {
      events.push("resolved");
      return value;
    });

    expect(events).toEqual(["summary", "resolved"]);
    expect(result).toEqual({
      ok: true,
      data: { path: "/docs/renamed.txt", entry: null },
    });
  });

  it("consumes native history before exposing the complete per-path batch outcome", async () => {
    const events: string[] = [];
    const summary = history(10);
    const outcome: FileBatchOutcome = {
      succeeded: ["/docs/removed.txt"],
      failed: [{ path: "/docs/locked.txt", error: "Permission denied" }],
      uncertain: [{ path: "/docs/unknown.txt", error: "worker exited" }],
      unstarted: ["/docs/later.txt"],
    };
    mocks.invoke.mockResolvedValue({ result: outcome, history: summary });
    mocks.receiveSummary.mockImplementation(() => { events.push("summary"); });

    const result = await invokeFileMutation<FileBatchOutcome>("delete_entries", {
      paths: [
        "/docs/removed.txt",
        "/docs/locked.txt",
        "/docs/unknown.txt",
        "/docs/later.txt",
      ],
      permanent: true,
    }).then((value) => {
      events.push("resolved");
      return value;
    });

    expect(events).toEqual(["summary", "resolved"]);
    expect(result).toEqual({ ok: true, data: outcome });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("delete_entries", {
      paths: [
        "/docs/removed.txt",
        "/docs/locked.txt",
        "/docs/unknown.txt",
        "/docs/later.txt",
      ],
      permanent: true,
      sessionId: "session-17",
    });
  });

  it("returns a committed null-metadata receipt and native warning as success", async () => {
    const summary = history(12);
    const warning = "Created the file, but metadata inspection failed";
    const receipt: FileMutationReceipt = { path: "/docs/new.txt", entry: null };
    mocks.invoke.mockResolvedValue({ result: receipt, history: summary, warning });

    expect(await invokeFileMutation<FileMutationReceipt>("create_empty_file", {
      parentPath: "/docs",
      name: "new.txt",
    })).toEqual({ ok: true, data: receipt, warning });
    expect(mocks.receiveSummary).toHaveBeenCalledExactlyOnceWith(summary);
  });

  it("preserves native command errors without publishing an invented history summary", async () => {
    mocks.invoke.mockRejectedValue({ kind: "permission_denied", message: "Read-only directory" });

    expect(await invokeFileMutation<FileMutationReceipt>("write_text_file", {
      path: "/locked/new.txt",
      content: "text",
    })).toEqual({ ok: false, error: "Read-only directory" });
    expect(mocks.receiveSummary).not.toHaveBeenCalled();
  });

  it("does not issue a separate history push after the mutation envelope settles", async () => {
    mocks.invoke.mockResolvedValue({
      result: { path: "/docs/link", entry: null },
      history: history(20),
    });

    await invokeFileMutation<FileMutationReceipt>("create_symlink", {
      targetPath: "/docs/target",
      linkPath: "/docs/link",
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["create_symlink"]);
    expect(mocks.invoke).not.toHaveBeenCalledWith("file_history_push", expect.anything());
  });
});
