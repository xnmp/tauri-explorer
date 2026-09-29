import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { emit } from "@tauri-apps/api/event";

const native = vi.hoisted(() => ({
  revision: 0,
  entries: null as FileEntry[] | null,
  paths: [] as string[],
  operation: null as "copy" | "cut" | null,
  failWrite: false,
  failRead: false,
}));
const errors = vi.hoisted(() => vi.fn());
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: { error: errors } }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("$lib/api/os-clipboard", () => ({
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  osClipboardHasFiles: vi.fn(async () => native.paths.length > 0),
  osClipboardPublish: async (entries: FileEntry[], operation: "copy" | "cut") => {
    if (native.failWrite && operation === "cut") throw new Error("native ownership unavailable");
    native.revision++;
    native.entries = entries;
    native.operation = operation;
    native.paths = entries.map((entry) => entry.path);
    return { ...native, mirrorError: native.failWrite ? "xclip unavailable" : null };
  },
  osClipboardSnapshot: async () => {
    if (native.failRead) throw new Error("xclip unavailable");
    return { ...native, mirrorError: null };
  },
  osClipboardCompareAndClear: async (revision: number) => {
    if (revision !== native.revision || !native.entries) return false;
    native.revision++;
    native.entries = null;
    native.operation = null;
    return true;
  },
  osClipboardRekey: async (revision: number, oldPath: string, entry: FileEntry) => {
    if (revision !== native.revision || !native.entries) return null;
    const index = native.entries.findIndex((candidate) => candidate.path === oldPath);
    if (index < 0) return null;
    native.revision++;
    native.entries = native.entries.map((candidate, at) => at === index ? entry : candidate);
    native.paths = native.entries.map((candidate) => candidate.path);
    return { ...native, mirrorError: null };
  },
}));

function entry(name: string): FileEntry {
  return { name, path: `/${name}`, kind: "file", size: 1, modified: "2026-09-30T00:00:00.000Z" };
}
async function freshStore() {
  vi.resetModules();
  return (await import("$lib/state/clipboard.svelte")).clipboardStore;
}

beforeEach(() => {
  native.revision++;
  native.entries = null;
  native.paths = [];
  native.operation = null;
  native.failWrite = false;
  native.failRead = false;
  errors.mockClear();
  vi.mocked(emit).mockClear();
});

describe("native clipboard contract", () => {
  it("rekeys a committed Cut and publishes an invalidation hint", async () => {
    const store = await freshStore();
    const original = entry("old.txt");
    await store.cut([original]);
    await store.rekeyPath(original.path, "/renamed.txt");
    expect(store.content?.entries[0]).toEqual({ ...original, name: "renamed.txt", path: "/renamed.txt" });
    expect(store.isCut).toBe(true);
    expect(native.paths).toEqual(["/renamed.txt"]);
    expect(emit).toHaveBeenLastCalledWith("app://clipboard-sync", { revision: store.revision });
    store.destroy();
  });

  it("keeps Copy available and reports a native mirror failure", async () => {
    native.failWrite = true;
    const store = await freshStore();
    expect(await store.copy([entry("a.txt")])).toBe(true);
    expect(store.content?.entries[0].path).toBe("/a.txt");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("xclip unavailable"));
    store.destroy();
  });

  it("rejects Cut when native ownership cannot be proven", async () => {
    native.failWrite = true;
    const store = await freshStore();
    expect(await store.cut([entry("a.txt")])).toBe(false);
    expect(store.isCut).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("native ownership unavailable"));
    store.destroy();
  });

  it("returns a read error without a toast", async () => {
    const store = await freshStore();
    native.failRead = true;
    const result = await store.readOsFiles();
    expect(result.error).toContain("xclip unavailable");
    expect(result.snapshot).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    store.destroy();
  });
});
