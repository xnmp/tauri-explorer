import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";

const backend = vi.hoisted(() => ({ empty: true, move: vi.fn() }));
const nativeEvents = vi.hoisted(() => ({ dispatch: undefined as undefined | ((event: { payload: { path: string } }) => void) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_event: string, callback: typeof nativeEvents.dispatch) => {
  nativeEvents.dispatch = callback;
  return () => { nativeEvents.dispatch = undefined; };
} }));
vi.mock("$lib/state/git-refresh", () => ({ subscribeGitChanges: async () => () => {} }));
vi.mock("$lib/api/move-session", () => ({ moveEntries: backend.move }));
vi.mock("$lib/api/files", async (importOriginal) => ({
  ...await importOriginal<typeof import("$lib/api/files")>(),
  isDirectoryEmpty: async () => backend.empty,
}));

import { emptyFolderResolver, EmptyFolderResolver } from "$lib/state/empty-folders.svelte";
import { moveFiles } from "$lib/state/move-operations";
import { operationsManager } from "$lib/state/operations.svelte";
import { useFileWatchers } from "$lib/composables/use-file-watchers";

const folder = (path: string, is_empty?: boolean): FileEntry => ({
  path, name: path.split("/").pop()!, kind: "directory", size: 0, modified: "", is_empty,
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.clearAllMocks();
  backend.empty = true;
  emptyFolderResolver.reset();
  for (const op of [...operationsManager.operations]) operationsManager.clearOperation(op.id);
});

describe("empty-folder state after native settlement", () => {
  it("rechecks native directory events through the existing window subscription", async () => {
    const watchers = useFileWatchers({ getAllExplorers: () => [] });
    try {
      watchers.setup();
      await flush();
      const destination = "/home/user/Archive";
      emptyFolderResolver.request(folder(destination));
      await flush();
      expect(emptyFolderResolver.isEmpty(destination)).toBe(true);
      backend.empty = false;
      expect(nativeEvents.dispatch).toBeDefined();
      nativeEvents.dispatch!({ payload: { path: destination } });
      await flush();
      expect(emptyFolderResolver.isEmpty(destination)).toBe(false);
    } finally {
      watchers.cleanup();
    }
  });

  it("keeps the actual empty destination after an entirely cancelled move", async () => {
    const destination = "/home/user/Archive";
    emptyFolderResolver.request(folder(destination));
    await flush();
    backend.move.mockResolvedValue({ ok: true, data: {
      items: [{ status: "unstarted" }], cancelled: true, warnings: [],
    } });
    const result = await moveFiles(["/home/user/file.txt"], destination, { onRefresh: () => {} });
    await flush();
    expect(result.complete).toBe(false);
    expect(emptyFolderResolver.isEmpty(destination)).toBe(true);
  });
  it.each(["uncertain publication", "lost reply"])("observes actual destination contents after %s", async (outcome) => {
    const destination = "/home/user/Archive";
    emptyFolderResolver.request(folder(destination));
    await flush();
    expect(emptyFolderResolver.isEmpty(destination)).toBe(true);
    backend.move.mockImplementation(async () => {
      backend.empty = false;
      return outcome === "lost reply"
        ? { ok: false, error: "reply lost after the native effect" }
        : { ok: true, data: {
          items: [{ status: "uncertain", error: "destination published; source removal failed" }],
          cancelled: false, warnings: [],
        } };
    });
    const result = await moveFiles(["/home/user/file.txt"], destination, { onRefresh: () => {} });
    await flush();
    expect(result.complete).toBe(false);
    expect(result.error).toBeTruthy();
    expect(emptyFolderResolver.isEmpty(destination)).toBe(false);
  });

  it("classifies hidden-only contents instead of trusting physical metadata", async () => {
    let showHidden = false;
    const resolver = new EmptyFolderResolver({
      resolveEmpty: async (_path, hidden) => !hidden, includeHidden: () => showHidden,
    });
    const entry = folder("/home/user/hidden-only", false);
    resolver.request(entry);
    await flush();
    expect(resolver.isEmpty(entry.path)).toBe(true);
    showHidden = true;
    resolver.request(entry);
    await flush();
    expect(resolver.isEmpty(entry.path)).toBe(false);
    showHidden = false;
    resolver.request(entry);
    await flush();
    expect(resolver.isEmpty(entry.path)).toBe(true);
  });

  it("preserves native POSIX backslashes in probes and keeps distinct folders separate", async () => {
    const literal = "/home/user/folder\\name";
    const nested = "/home/user/folder/name";
    let literalEmpty = false;
    const resolver = new EmptyFolderResolver({
      resolveEmpty: async path => path === literal ? literalEmpty : false,
      includeHidden: () => false,
    });
    resolver.request(folder(literal));
    resolver.request(folder(nested));
    await flush();
    literalEmpty = true;
    resolver.invalidate([literal]);
    await flush();
    expect(resolver.isEmpty(literal)).toBe(true);
    expect(resolver.isEmpty(nested)).toBe(false);
  });
});
