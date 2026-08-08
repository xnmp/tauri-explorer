/**
 * Config autoreload wiring (#599).
 *
 * `decideConfigReload` is unit-tested on its own; this suite pins the two
 * things above it that a pure function can't:
 *
 *  - `settingsStore.reloadFromDisk` really re-reads the file, adopts external
 *    edits, and refuses our own writes (the loop/revert hazard);
 *  - `handleConfigFileChanged` routes settings.json to the settings reload and
 *    themes/*.css to the theme re-injection, and only touches the theme when
 *    the reload actually changed something.
 *
 * The end-to-end path (a real editor writing the file, the Rust watcher
 * noticing, the window repainting) is verified against the real binary — a
 * browser E2E here would only prove the mock agrees with itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readConfigFileMock = vi.fn();
const writeConfigFileMock = vi.fn();

vi.mock("$lib/api/files", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    readConfigFile: (...args: unknown[]) => readConfigFileMock(...args),
    // persisted.writeConfigQueued is exercised for real so its
    // pending/last-written bookkeeping is under test too; only the IPC leaf
    // is faked.
    writeConfigFile: (...args: unknown[]) => writeConfigFileMock(...args),
  };
});

async function freshSettings() {
  vi.resetModules();
  const persisted = await import("$lib/state/persisted");
  const settings = await import("$lib/state/settings.svelte");
  return {
    ...settings,
    /** Wait until no config write is outstanding, so a later reload is not
     *  rejected as racing one. `writeConfigFile` being *called* is not enough
     *  — the queue clears a microtask after it resolves. */
    settleWrites: () =>
      vi.waitFor(() =>
        expect(persisted.configWriteActivity("settings.json").pending).toBe(false),
      ),
  };
}

async function freshConfigStores() {
  vi.resetModules();
  const persisted = await import("$lib/state/persisted");
  const bookmarks = await import("$lib/state/bookmarks.svelte");
  const folderViews = await import("$lib/state/folder-views.svelte");
  return {
    ...bookmarks,
    ...folderViews,
    settleWrites: (filename: string) =>
      vi.waitFor(() => expect(persisted.configWriteActivity(filename).pending).toBe(false)),
  };
}

function blob(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
  writeConfigFileMock.mockResolvedValue({ ok: true, data: undefined });
});

describe("settingsStore.reloadFromDisk", () => {
  it("adopts a theme changed in settings.json outside the app", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();
    expect(settingsStore.theme).toBe("light");

    readConfigFileMock.mockResolvedValue({ ok: true, data: blob({ theme: "nord" }) });
    expect(await settingsStore.reloadFromDisk()).toBe("external-change");
    expect(settingsStore.theme).toBe("nord");
  });

  it("adopts non-theme settings too", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();
    expect(settingsStore.showHidden).toBe(false);

    readConfigFileMock.mockResolvedValue({
      ok: true,
      data: blob({ showHidden: true, showSidebar: false }),
    });
    expect(await settingsStore.reloadFromDisk()).toBe("external-change");
    expect(settingsStore.showHidden).toBe(true);
    expect(settingsStore.showSidebar).toBe(false);
  });

  it("keeps missing keys at their defaults rather than dropping them", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();

    readConfigFileMock.mockResolvedValue({ ok: true, data: blob({ theme: "nord" }) });
    await settingsStore.reloadFromDisk();
    expect(settingsStore.zoomLevel).toBe(100);
    expect(settingsStore.showSidebar).toBe(true);
  });

  it("ignores the app's own save coming back through the watcher", async () => {
    const { settingsStore, settleWrites } = await freshSettings();
    await settingsStore.init();
    settingsStore.setTheme("nord");
    // Let the queued write land so it is recorded as ours.
    await settleWrites();
    const written = writeConfigFileMock.mock.calls.at(-1)![1] as string;

    readConfigFileMock.mockResolvedValue({ ok: true, data: written });
    expect(await settingsStore.reloadFromDisk()).toBe("own-write-echo");
    expect(settingsStore.theme).toBe("nord");
  });

  it("does not revert a change made while an older write is still in flight", async () => {
    // The revert hazard: the watcher reports write N after memory moved to
    // N+1, so the file still holds N. Adopting it would undo the user's edit.
    const { settingsStore } = await freshSettings();
    await settingsStore.init();

    let releaseWrite: () => void = () => {};
    writeConfigFileMock.mockImplementation(
      () => new Promise((resolve) => {
        releaseWrite = () => resolve({ ok: true, data: undefined });
      }),
    );
    settingsStore.setTheme("nord");
    readConfigFileMock.mockResolvedValue({ ok: true, data: blob({ theme: "light" }) });

    expect(await settingsStore.reloadFromDisk()).toBe("self-write-overlap");
    expect(settingsStore.theme).toBe("nord");
    releaseWrite();
  });

  /**
   * Regression, found by adversarial review: a write that both STARTS and
   * FINISHES inside the read window leaves "is a write pending" false at both
   * ends, so a pending-flag-only guard adopts the pre-write bytes and silently
   * reverts the user's change — durably, since memory and disk then disagree.
   */
  it("does not revert a change made entirely within the read window", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();

    let issueWrite: (() => void) | null = () => {};
    readConfigFileMock.mockImplementation(async () => {
      // The change lands while this read is in flight, and settles before it
      // resolves — the exact window a pending flag cannot see.
      issueWrite?.();
      issueWrite = null;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ok: true, data: blob({ theme: "light" }) };
    });
    issueWrite = () => settingsStore.setTheme("nord");

    expect(await settingsStore.reloadFromDisk()).toBe("self-write-overlap");
    expect(settingsStore.theme).toBe("nord");
  });

  it("keeps the current settings when the file is unreadable or corrupt", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();
    settingsStore.setTheme("nord");

    // Let the setTheme write settle so it cannot be mistaken for a race.
    await vi.waitFor(() => expect(writeConfigFileMock).toHaveBeenCalled());

    readConfigFileMock.mockResolvedValue({ ok: false, error: "EACCES" });
    expect(await settingsStore.reloadFromDisk()).toBe("unusable");
    expect(settingsStore.theme).toBe("nord");

    for (const data of ["", "{ truncated", "null", "[1,2,3]"]) {
      readConfigFileMock.mockResolvedValue({ ok: true, data });
      expect(await settingsStore.reloadFromDisk()).toBe("unusable");
      expect(settingsStore.theme).toBe("nord");
    }
  });

  it("reports no change when the file matches what is already in memory", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();

    readConfigFileMock.mockResolvedValue({ ok: true, data: blob({ theme: "light" }) });
    expect(await settingsStore.reloadFromDisk()).toBe("unchanged");
  });

  it("adopts a settings.json write from a plugin rather than mistaking it for its own echo", async () => {
    const { settingsStore, settleWrites } = await freshSettings();
    const { writeConfigQueued } = await import("$lib/state/persisted");
    await settingsStore.init();

    const external = blob({ theme: "nord" });
    await writeConfigQueued("settings.json", external, "nano-banana");
    await settleWrites();
    readConfigFileMock.mockResolvedValue({ ok: true, data: external });

    expect(await settingsStore.reloadFromDisk()).toBe("external-change");
    expect(settingsStore.theme).toBe("nord");
  });
});

describe("bookmark and folder-view config stores", () => {
  it("adopts bookmarks edited outside the app", async () => {
    const { bookmarksStore } = await freshConfigStores();
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

  it("adopts folder-view overrides edited outside the app", async () => {
    const { folderViewsStore } = await freshConfigStores();
    await folderViewsStore.init();
    readConfigFileMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ "/work/photos": { thumbnailSize: "xlarge" } }),
    });

    expect(await folderViewsStore.reloadFromDisk()).toBe("external-change");
    expect(folderViewsStore.getThumbnailSize("/work/photos", "small")).toBe("xlarge");
  });

  it("does not replace a bookmark change while the app's save is in flight", async () => {
    const { bookmarksStore } = await freshConfigStores();
    await bookmarksStore.init();
    let releaseWrite: () => void = () => {};
    writeConfigFileMock.mockImplementation(
      () => new Promise((resolve) => {
        releaseWrite = () => resolve({ ok: true, data: undefined });
      }),
    );
    bookmarksStore.addBookmark("/work/current", "Current");
    readConfigFileMock.mockResolvedValue({ ok: true, data: "[]" });

    expect(await bookmarksStore.reloadFromDisk()).toBe("self-write-overlap");
    expect(bookmarksStore.list).toEqual([
      { name: "Current", path: "/work/current", icon: "folder" },
    ]);
    releaseWrite();
  });
});

describe("handleConfigFileChanged", () => {
  async function wired(options: { reloadResult: string }) {
    vi.resetModules();
    const syncFromSettings = vi.fn();
    const initTheme = vi.fn(async () => {});
    const reloadFromDisk = vi.fn(async () => options.reloadResult);
    const reloadBookmarks = vi.fn(async () => options.reloadResult);
    const reloadFolderViews = vi.fn(async () => options.reloadResult);
    const showToast = vi.fn();

    vi.doMock("$lib/state/settings.svelte", () => ({
      settingsStore: { reloadFromDisk },
    }));
    vi.doMock("$lib/state/theme.svelte", () => ({
      themeStore: { syncFromSettings, initTheme },
    }));
    vi.doMock("$lib/state/bookmarks.svelte", () => ({
      bookmarksStore: { reloadFromDisk: reloadBookmarks },
    }));
    vi.doMock("$lib/state/folder-views.svelte", () => ({
      folderViewsStore: { reloadFromDisk: reloadFolderViews },
    }));
    vi.doMock("$lib/state/toast.svelte", () => ({
      toastStore: { show: showToast },
    }));

    const { handleConfigFileChanged } = await import("$lib/state/config-watch");
    return {
      handleConfigFileChanged,
      reloadFromDisk,
      reloadBookmarks,
      reloadFolderViews,
      syncFromSettings,
      initTheme,
      showToast,
    };
  }

  it("re-applies the theme after settings.json really changed", async () => {
    const w = await wired({ reloadResult: "external-change" });
    await w.handleConfigFileChanged("settings.json");
    expect(w.reloadFromDisk).toHaveBeenCalledOnce();
    expect(w.syncFromSettings).toHaveBeenCalledOnce();
    expect(w.initTheme).not.toHaveBeenCalled();
  });

  it("does not repaint the theme when the reload was a no-op", async () => {
    for (const reason of ["own-write-echo", "self-write-overlap", "unchanged"]) {
      const w = await wired({ reloadResult: reason });
      await w.handleConfigFileChanged("settings.json");
      expect(w.reloadFromDisk).toHaveBeenCalledOnce();
      expect(w.syncFromSettings).not.toHaveBeenCalled();
      expect(w.showToast).not.toHaveBeenCalled();
    }
  });

  it("tells the user when their hand-edited settings.json cannot be read", async () => {
    // Silence here reads as "autoreload is broken" rather than "your JSON has
    // a typo", while the visible settings are no longer the ones they wrote.
    const w = await wired({ reloadResult: "unusable" });
    await w.handleConfigFileChanged("settings.json");
    expect(w.syncFromSettings).not.toHaveBeenCalled();
    expect(w.showToast).toHaveBeenCalledOnce();
    expect(w.showToast.mock.calls[0][0]).toMatch(/settings\.json/);
    expect(w.showToast.mock.calls[0][1]).toBe("error");
  });

  it("re-injects user theme CSS when a themes/*.css file changes", async () => {
    const w = await wired({ reloadResult: "unchanged" });
    await w.handleConfigFileChanged("themes/midnight.css");
    expect(w.initTheme).toHaveBeenCalledOnce();
    expect(w.reloadFromDisk).not.toHaveBeenCalled();
  });

  it("reloads bookmarks and folder views when their config files change", async () => {
    const w = await wired({ reloadResult: "external-change" });
    await w.handleConfigFileChanged("bookmarks.json");
    await w.handleConfigFileChanged("folder-views.json");
    expect(w.reloadFromDisk).not.toHaveBeenCalled();
    expect(w.reloadBookmarks).toHaveBeenCalledOnce();
    expect(w.reloadFolderViews).toHaveBeenCalledOnce();
    expect(w.initTheme).not.toHaveBeenCalled();
    expect(w.syncFromSettings).not.toHaveBeenCalled();
  });
});
