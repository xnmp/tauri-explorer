/**
 * Virtual-path guards (#152): mutating / side-effecting real-fs API wrappers
 * must reject `scheme://…` paths gracefully instead of forwarding them to the
 * OS backend. The guard returns before invoke(), so no mocking is needed.
 */

import { describe, it, expect } from "vitest";
import {
  renameEntry,
  deleteEntry,
  deleteEntryPermanent,
  copyEntry,
  moveEntry,
  openFile,
  openFileWith,
  readTextFile,
  createDirectory,
  createSymlink,
  compressToZip,
  extractArchive,
  getThumbnailData,
} from "$lib/api/files";

const V = "demo://notes/a.txt";

async function expectRejected(result: Promise<{ ok: boolean; error?: string }>) {
  const r = await result;
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toContain("demo://");
  expect((r as { error: string }).error).toContain("read-only");
}

describe("virtual path guards", () => {
  it("rejects mutations on virtual paths", async () => {
    await expectRejected(renameEntry(V, "b.txt"));
    await expectRejected(deleteEntry(V));
    await expectRejected(deleteEntryPermanent(V));
    await expectRejected(createDirectory("demo://", "sub"));
    await expectRejected(createSymlink(V, "/tmp/link"));
    await expectRejected(compressToZip([V]));
    await expectRejected(extractArchive("demo://a.zip"));
  });

  it("rejects transfers when either side is virtual", async () => {
    await expectRejected(copyEntry(V, "/tmp"));
    await expectRejected(copyEntry("/tmp/a.txt", "demo://"));
    await expectRejected(moveEntry(V, "/tmp"));
    await expectRejected(moveEntry("/tmp/a.txt", "demo://"));
  });

  it("rejects opening/reading virtual paths via the OS backend", async () => {
    await expectRejected(openFile(V));
    await expectRejected(openFileWith(V, "gimp"));
    await expectRejected(readTextFile(V));
    await expectRejected(getThumbnailData(V, 64) as never);
  });

  it("does not treat Windows drive paths as virtual", async () => {
    // C://-style never matches (single-letter scheme); this must reach the
    // backend (and fail differently in the node test env), not the guard.
    const r = await renameEntry("C:/Users/x/a.txt", "b.txt");
    if (!r.ok) {
      expect(r.error).not.toContain("read-only virtual");
    }
  });
});
