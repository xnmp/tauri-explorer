/** Regression coverage for #605's config files and writer ownership. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileMock = vi.fn();
const writeConfigFileMock = vi.fn();

vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readConfigFile: (...args: unknown[]) => readConfigFileMock(...args),
  writeConfigFile: (...args: unknown[]) => writeConfigFileMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
  writeConfigFileMock.mockResolvedValue({ ok: true, data: undefined });
});

async function freshStores() {
  vi.resetModules();
  const bookmarks = await import("$lib/state/bookmarks.svelte");
  const folderViews = await import("$lib/state/folder-views.svelte");
  const settings = await import("$lib/state/settings.svelte");
  return { ...bookmarks, ...folderViews, ...settings };
}

describe("externally edited config stores (#605)", () => {
  it("makes an externally edited bookmark available to the sidebar store", async () => {
    const { bookmarksStore } = await freshStores();
    await bookmarksStore.init();
    readConfigFileMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify([{ name: "Projects", path: "/work/projects", icon: "folder" }]),
    });

    expect(await bookmarksStore.reloadFromDisk()).toBe("external-change");
    expect(bookmarksStore.list).toEqual([
      { name: "Projects", path: "/work/projects", icon: "folder" },
    ]);
  });

  it("makes an externally edited folder-view override effective", async () => {
    const { folderViewsStore } = await freshStores();
    await folderViewsStore.init();
    readConfigFileMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ "/work/photos": { thumbnailSize: "xlarge" } }),
    });

    expect(await folderViewsStore.reloadFromDisk()).toBe("external-change");
    expect(folderViewsStore.getThumbnailSize("/work/photos", "small")).toBe("xlarge");
  });

  it("adopts a plugin-owned settings write rather than treating it as the settings echo", async () => {
    const { settingsStore } = await freshStores();
    const { writeConfigQueued } = await import("$lib/state/persisted");
    await settingsStore.init();
    const external = JSON.stringify({ theme: "nord" });
    await writeConfigQueued("settings.json", external, "nano-banana");
    readConfigFileMock.mockResolvedValue({ ok: true, data: external });

    expect(await settingsStore.reloadFromDisk()).toBe("external-change");
    expect(settingsStore.theme).toBe("nord");
  });

  it("keeps a same-writer queued bookmark save active when its pending write is replaced", async () => {
    const { bookmarksStore } = await freshStores();
    await bookmarksStore.init();
    const completions: Array<() => void> = [];
    writeConfigFileMock.mockImplementation(
      () => new Promise((resolve) => completions.push(() => resolve({ ok: true, data: undefined }))),
    );
    bookmarksStore.addBookmark("/work/one", "One");
    bookmarksStore.addBookmark("/work/two", "Two");
    bookmarksStore.addBookmark("/work/three", "Three");
    // A is in flight; B is queued, then C replaces B. The stale on-disk
    // bytes must still be rejected before A hands off to C.
    readConfigFileMock.mockResolvedValue({ ok: true, data: "[]" });

    expect(await bookmarksStore.reloadFromDisk()).toBe("self-write-overlap");
    expect(bookmarksStore.list.map((bookmark) => bookmark.name)).toEqual(["One", "Two", "Three"]);
    completions.shift()?.();
    await vi.waitFor(() => expect(writeConfigFileMock).toHaveBeenCalledTimes(2));
    completions.shift()?.();
  });
});

describe("config watcher routing (#605)", () => {
  it("routes bookmark and folder-view events to their live stores", async () => {
    vi.resetModules();
    const reloadBookmarks = vi.fn();
    const reloadFolderViews = vi.fn();
    vi.doMock("$lib/state/bookmarks.svelte", () => ({ bookmarksStore: { reloadFromDisk: reloadBookmarks } }));
    vi.doMock("$lib/state/folder-views.svelte", () => ({ folderViewsStore: { reloadFromDisk: reloadFolderViews } }));
    vi.doMock("$lib/state/settings.svelte", () => ({ settingsStore: { reloadFromDisk: vi.fn() } }));
    vi.doMock("$lib/state/theme.svelte", () => ({ themeStore: { syncFromSettings: vi.fn(), initTheme: vi.fn() } }));
    vi.doMock("$lib/state/toast.svelte", () => ({ toastStore: { show: vi.fn() } }));
    const { handleConfigFileChanged } = await import("$lib/state/config-watch");

    await handleConfigFileChanged("bookmarks.json");
    await handleConfigFileChanged("folder-views.json");
    expect(reloadBookmarks).toHaveBeenCalledOnce();
    expect(reloadFolderViews).toHaveBeenCalledOnce();
  });
});
