/**
 * Archive writes are admitted mutations (#686, ADR 0024): they must carry the
 * acknowledged renderer session and consume the settled history reply, exactly
 * as every other file mutation does. Read-only archive listing must not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistorySummary } from "$lib/domain/file-history";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSession: vi.fn(),
  receiveSummary: vi.fn(),
}));

vi.mock("$lib/api/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/common")>()),
  invoke: mocks.invoke,
}));

vi.mock("$lib/api/native-resource-session", () => ({
  getNativeResourceSession: mocks.getSession,
  receiveHistorySummary: mocks.receiveSummary,
}));

import { compressToZip, extractArchive, listArchiveContents } from "$lib/api/archive";

const summary: HistorySummary = {
  revision: 9,
  undoId: null,
  redoId: null,
  stackSize: 0,
  busy: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue("session-42");
});

describe("archive mutation admission", () => {
  it("compresses through the renderer session and settles its history", async () => {
    mocks.invoke.mockResolvedValue({ result: "/docs/Archive.zip", history: summary });

    await expect(compressToZip(["/docs/a.txt", "/docs/b.txt"], 7)).resolves.toEqual({
      ok: true,
      data: "/docs/Archive.zip",
    });

    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("compress_to_zip", {
      paths: ["/docs/a.txt", "/docs/b.txt"],
      jobId: 7,
      sessionId: "session-42",
    });
    expect(mocks.receiveSummary).toHaveBeenCalledExactlyOnceWith(summary);
  });

  it("extracts through the renderer session and settles its history", async () => {
    mocks.invoke.mockResolvedValue({ result: "/docs/pack", history: summary });

    await expect(extractArchive("/docs/pack.zip", false, 8)).resolves.toEqual({
      ok: true,
      data: "/docs/pack",
    });

    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("extract_archive", {
      archivePath: "/docs/pack.zip",
      extractHere: false,
      jobId: 8,
      sessionId: "session-42",
    });
    expect(mocks.receiveSummary).toHaveBeenCalledExactlyOnceWith(summary);
  });

  it("reports a refused admission as an ordinary failure without settling history", async () => {
    mocks.invoke.mockRejectedValue(
      new Error("Could not acquire file operation ownership: Another operation or unresolved recovery owns these files"),
    );

    const result = await extractArchive("/docs/pack.zip", true);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("owns these files");
    expect(mocks.receiveSummary).not.toHaveBeenCalled();
  });

  it("surfaces a cleanup warning alongside a committed archive", async () => {
    mocks.invoke.mockResolvedValue({
      result: "/docs/pack",
      history: summary,
      warning: "Archive operation finished, but its ownership record could not be retired: busy",
    });

    const result = await extractArchive("/docs/pack.zip", true);

    expect(result).toMatchObject({ ok: true, data: "/docs/pack" });
    expect(result.ok === true && result.warning).toContain("could not be retired");
  });

  it("keeps the read-only listing off the mutation path", async () => {
    mocks.invoke.mockResolvedValue({ entries: [], rootFolder: null });

    await expect(listArchiveContents("/docs/pack.zip")).resolves.toEqual({
      ok: true,
      data: { entries: [], rootFolder: null },
    });

    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.receiveSummary).not.toHaveBeenCalled();
  });
});
