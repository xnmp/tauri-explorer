/** Local mutation deduplication must not hide a later external write. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type {
  DirectoryListingCallbacks,
  DirectoryListingResult,
  DirectoryObservation,
} from "$lib/state/directory-listing";

const ROOT = "/watched";

const harness = vi.hoisted(() => ({
  diskEntries: [] as FileEntry[],
  createDirectory: vi.fn(),
}));

vi.mock("$lib/state/directory-events", () => ({
  directoryEvents: {
    subscribe: () => ({
      ready: () => Promise.resolve(),
      stop: () => {},
    }),
  },
}));

vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: async (
      path: string,
      _callbacks: DirectoryListingCallbacks,
      observation?: DirectoryObservation,
    ): Promise<DirectoryListingResult> => {
      await observation?.ready;
      if (observation && !observation.accept(null)) {
        return { ok: false, error: "Directory navigation was superseded" };
      }
      return { ok: true, path, entries: [...harness.diskEntries], streaming: false };
    },
    cleanup: async () => {},
  }),
}));

vi.mock("$lib/api/files", async (importOriginal) => ({
  ...await importOriginal<typeof import("$lib/api/files")>(),
  createDirectory: harness.createDirectory,
}));

import { createExplorerState } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";

function file(name: string): FileEntry {
  return {
    name,
    path: `${ROOT}/${name}`,
    kind: "file",
    size: 1,
    modified: "2026-09-08T00:00:00Z",
  };
}

function directory(name: string): FileEntry {
  return {
    ...file(name),
    kind: "directory",
    size: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  localStorage.clear();
  harness.diskEntries = [file("seed.txt")];
  harness.createDirectory.mockReset();
  harness.createDirectory.mockImplementation(async (parentPath: string, name: string) => {
    const created = directory(name);
    expect(parentPath).toBe(ROOT);
    harness.diskEntries = [...harness.diskEntries, created];
    return { ok: true as const, data: created };
  });
});

afterEach(() => {
  cancelPendingRefreshes();
  vi.useRealTimers();
});

describe("pane mutation watcher admission", () => {
  it("shows an external write observed inside an own-create interval", async () => {
    const explorer = createExplorerState();
    try {
      await explorer.navigateTo(ROOT, { autoEnterSingleSubdir: false });
      expect(await explorer.createFolder("created-here")).toBeNull();
      expect(explorer.displayEntries.map(({ name }) => name)).toEqual([
        "created-here",
        "seed.txt",
      ]);

      harness.diskEntries = [...harness.diskEntries, file("external.txt")];
      explorer.directoryChanged({ path: ROOT, observedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(150);

      expect(explorer.displayEntries.map(({ name }) => name)).toEqual([
        "created-here",
        "external.txt",
        "seed.txt",
      ]);
    } finally {
      await explorer.destroy();
    }
  });
});
