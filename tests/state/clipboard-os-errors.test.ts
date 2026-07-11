/**
 * OS-clipboard failure surfacing (#279).
 *
 * The in-app clipboard must keep working when the OS clipboard bridge fails
 * (e.g. wl-clipboard not installed), and the failure must surface as a toast
 * instead of vanishing into console.error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry } from "$lib/domain/file";

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

describe("clipboard OS-bridge failures (#279)", () => {
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

  it("readOsFiles toasts and returns null when the OS read fails", async () => {
    readFilesMock.mockResolvedValue({ ok: false, error: "xclip is not installed" });
    const store = await freshStore();

    const result = await store.readOsFiles();

    expect(result).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("xclip is not installed"));
  });

  it("readOsFiles treats an empty clipboard as no-files, not an error", async () => {
    readFilesMock.mockResolvedValue({ ok: true, data: [] });
    const store = await freshStore();

    const result = await store.readOsFiles();

    expect(result).toBeNull();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("readOsFiles returns paths when the OS clipboard has files", async () => {
    readFilesMock.mockResolvedValue({ ok: true, data: ["/x.png", "/y.png"] });
    const store = await freshStore();

    const result = await store.readOsFiles();

    expect(result).toEqual({ paths: ["/x.png", "/y.png"], operation: "copy" });
  });
});
