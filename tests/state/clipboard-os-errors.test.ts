/**
 * OS-clipboard failure surfacing (#279).
 *
 * The in-app clipboard must keep working when the OS clipboard bridge fails
 * (e.g. wl-clipboard not installed), and the failure must surface as a toast
 * instead of vanishing into console.error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { emit, listen } from "@tauri-apps/api/event";

const writeFilesMock = vi.fn();
const readFilesMock = vi.fn();
vi.mock("$lib/api/os-clipboard", () => ({
  osClipboardHasFiles: vi.fn(async () => false),
  osClipboardReadFiles: (...args: unknown[]) => readFilesMock(...args),
  osClipboardWriteFiles: (...args: unknown[]) => writeFilesMock(...args),
}));

const toastErrorMock = vi.fn();
vi.mock("$lib/state/toast.svelte", () => ({
  toastStore: { error: (msg: string) => toastErrorMock(msg), show: vi.fn() },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

function entry(name: string): FileEntry {
  return { name, path: `/${name}`, kind: "file", size: 1, modified: "2024-01-01T00:00:00.000Z" };
}

async function freshStore() {
  vi.resetModules();
  const mod = await import("$lib/state/clipboard.svelte");
  return mod.clipboardStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("committed clipboard renames", () => {
  it("rekeys cut membership and publishes the new path without fresh metadata", async () => {
    writeFilesMock.mockResolvedValue({ ok: true });
    const store = await freshStore();
    const original = entry("a.txt");
    const sibling = entry("b.txt");
    await store.cut([original, sibling]);

    store.rekeyPath(original.path, "/renamed.txt", null);

    expect(store.isCut).toBe(true);
    expect([...store.pathSet]).toEqual(["/renamed.txt", sibling.path]);
    expect(store.content?.entries).toEqual([
      { ...original, path: "/renamed.txt", name: "renamed.txt" }, sibling,
    ]);
    expect(emit).toHaveBeenLastCalledWith("app://clipboard-sync", store.content);
    expect(original.path).toBe("/a.txt");
    store.destroy();
  });

  it("retains a fresh snapshot when provided and ignores an unrelated rename", async () => {
    writeFilesMock.mockResolvedValue({ ok: true });
    const store = await freshStore();
    await store.copy([entry("a.txt")]);
    const renamed = { ...entry("renamed.txt"), size: 12 };
    store.rekeyPath("/a.txt", renamed.path, renamed);
    store.rekeyPath("/unrelated.txt", "/elsewhere.txt");
    expect(store.content?.entries).toEqual([renamed]);
    store.destroy();
  });
});

describe("clipboard OS-bridge failures (#279)", () => {
  it("a paste immediately after Copy reads the new files, not the previous OS clipboard", async () => {
    let finishWrite!: () => void;
    let osPaths = ["/previous.txt"];
    writeFilesMock.mockImplementation((paths: string[]) => new Promise((resolve) => {
      finishWrite = () => {
        osPaths = paths;
        resolve({ ok: true, data: undefined });
      };
    }));
    readFilesMock.mockImplementation(async () => ({ ok: true, data: [...osPaths] }));
    const store = await freshStore();

    const copying = store.copy([entry("new.txt")]);
    const pasting = store.readOsFiles();
    await vi.waitFor(() => expect(writeFilesMock).toHaveBeenCalled());
    expect(emit).not.toHaveBeenCalled();
    finishWrite();

    expect(await pasting).toEqual({
      content: { paths: ["/new.txt"], operation: "copy" },
      error: null,
    });
    await copying;
    expect(emit).toHaveBeenCalledWith("app://clipboard-sync", store.content);
    store.destroy();
  });

  it("rapid successive copies leave the newest files in the OS clipboard", async () => {
    const writes: Array<() => void> = [];
    let osPaths: string[] = [];
    writeFilesMock.mockImplementation((paths: string[]) => new Promise((resolve) => {
      writes.push(() => {
        osPaths = paths;
        resolve({ ok: true, data: undefined });
      });
    }));
    readFilesMock.mockImplementation(async () => ({ ok: true, data: [...osPaths] }));
    const store = await freshStore();

    const first = store.copy([entry("first.txt")]);
    const second = store.copy([entry("second.txt")]);
    const pasting = store.readOsFiles();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0]();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1]();

    expect(await pasting).toEqual({
      content: { paths: ["/second.txt"], operation: "copy" },
      error: null,
    });
    await Promise.all([first, second]);
    expect(emit).toHaveBeenLastCalledWith("app://clipboard-sync", store.content);
    store.destroy();
  });

  it("an OS read waits for a newer copy queued while it awaited an earlier write", async () => {
    const writes: Array<() => void> = [];
    let osPaths: string[] = [];
    writeFilesMock.mockImplementation((paths: string[]) => new Promise((resolve) => {
      writes.push(() => {
        osPaths = paths;
        resolve({ ok: true, data: undefined });
      });
    }));
    readFilesMock.mockImplementation(async () => ({ ok: true, data: [...osPaths] }));
    const store = await freshStore();

    const first = store.copy([entry("first.txt")]);
    const pasting = store.readOsFiles();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const second = store.cut([entry("second.txt")]);
    writes[0]();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(readFilesMock).not.toHaveBeenCalled();
    writes[1]();

    expect(await pasting).toEqual({
      content: { paths: ["/second.txt"], operation: "copy" },
      error: null,
    });
    await Promise.all([first, second]);
    store.destroy();
  });

  it("does not treat another window's Copy as this window's pending local Copy", async () => {
    let finishWrite!: () => void;
    writeFilesMock.mockImplementation(() => new Promise((resolve) => {
      finishWrite = () => resolve({ ok: true, data: undefined });
    }));
    const store = await freshStore();
    const copying = store.copy([entry("local.txt")]);
    await vi.waitFor(() => expect(writeFilesMock).toHaveBeenCalled());
    expect(store.hasPendingLocalCopy).toBe(true);

    const onClipboardEvent = vi.mocked(listen).mock.calls.at(-1)?.[1];
    expect(onClipboardEvent).toBeDefined();
    onClipboardEvent!({ payload: { entries: [entry("remote.txt")], operation: "copy" } } as never);

    expect(store.content?.entries.map((item) => item.name)).toEqual(["remote.txt"]);
    expect(store.hasPendingLocalCopy).toBe(false);
    finishWrite();
    await copying;
    store.destroy();
  });

  it("copy keeps the in-app clipboard and toasts when the OS write fails", async () => {
    writeFilesMock.mockResolvedValue({ ok: false, error: "wl-copy is not installed" });
    const store = await freshStore();

    await store.copy([entry("a.txt")]);

    // In-app clipboard still holds the entry — pasting inside the app works.
    expect(store.content?.entries.map((e) => e.name)).toEqual(["a.txt"]);
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("wl-copy is not installed"),
    );
  });

  it("copy stays silent when the OS write succeeds", async () => {
    writeFilesMock.mockResolvedValue({ ok: true, data: undefined });
    const store = await freshStore();

    await store.copy([entry("a.txt")]);

    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("readOsFiles returns the error WITHOUT toasting when the OS read fails (#401)", async () => {
    readFilesMock.mockResolvedValue({ ok: false, error: "xclip is not installed" });
    const store = await freshStore();

    const result = await store.readOsFiles();

    // The caller decides whether the failure matters — an image paste can
    // still succeed after a failed file-list read (macOS), so no toast here.
    expect(result).toEqual({ content: null, error: "xclip is not installed" });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("readOsFiles treats an empty clipboard as no-files, not an error", async () => {
    readFilesMock.mockResolvedValue({ ok: true, data: [] });
    const store = await freshStore();

    const result = await store.readOsFiles();

    expect(result).toEqual({ content: null, error: null });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("readOsFiles returns paths when the OS clipboard has files", async () => {
    readFilesMock.mockResolvedValue({ ok: true, data: ["/x.png", "/y.png"] });
    const store = await freshStore();

    const result = await store.readOsFiles();

    expect(result).toEqual({
      content: { paths: ["/x.png", "/y.png"], operation: "copy" },
      error: null,
    });
  });
});
