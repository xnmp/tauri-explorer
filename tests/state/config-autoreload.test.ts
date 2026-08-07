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
  return await import("$lib/state/settings.svelte");
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
    expect(await settingsStore.reloadFromDisk()).toBe(true);
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
    expect(await settingsStore.reloadFromDisk()).toBe(true);
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
    const { settingsStore } = await freshSettings();
    await settingsStore.init();
    settingsStore.setTheme("nord");
    // Let the queued write land so it is recorded as ours.
    await vi.waitFor(() => expect(writeConfigFileMock).toHaveBeenCalled());
    const written = writeConfigFileMock.mock.calls.at(-1)![1] as string;

    readConfigFileMock.mockResolvedValue({ ok: true, data: written });
    expect(await settingsStore.reloadFromDisk()).toBe(false);
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

    expect(await settingsStore.reloadFromDisk()).toBe(false);
    expect(settingsStore.theme).toBe("nord");
    releaseWrite();
  });

  it("keeps the current settings when the file is unreadable or corrupt", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();
    settingsStore.setTheme("nord");

    readConfigFileMock.mockResolvedValue({ ok: false, error: "EACCES" });
    expect(await settingsStore.reloadFromDisk()).toBe(false);
    expect(settingsStore.theme).toBe("nord");

    for (const data of ["", "{ truncated", "null", "[1,2,3]"]) {
      readConfigFileMock.mockResolvedValue({ ok: true, data });
      expect(await settingsStore.reloadFromDisk()).toBe(false);
      expect(settingsStore.theme).toBe("nord");
    }
  });

  it("reports no change when the file matches what is already in memory", async () => {
    const { settingsStore } = await freshSettings();
    await settingsStore.init();

    readConfigFileMock.mockResolvedValue({ ok: true, data: blob({ theme: "light" }) });
    expect(await settingsStore.reloadFromDisk()).toBe(false);
  });
});

describe("handleConfigFileChanged", () => {
  async function wired(options: {
    reloadResult: boolean;
  }) {
    vi.resetModules();
    const syncFromSettings = vi.fn();
    const initTheme = vi.fn(async () => {});
    const reloadFromDisk = vi.fn(async () => options.reloadResult);

    vi.doMock("$lib/state/settings.svelte", () => ({
      settingsStore: { reloadFromDisk },
    }));
    vi.doMock("$lib/state/theme.svelte", () => ({
      themeStore: { syncFromSettings, initTheme },
    }));

    const { handleConfigFileChanged } = await import("$lib/state/config-watch");
    return { handleConfigFileChanged, reloadFromDisk, syncFromSettings, initTheme };
  }

  it("re-applies the theme after settings.json really changed", async () => {
    const w = await wired({ reloadResult: true });
    await w.handleConfigFileChanged("settings.json");
    expect(w.reloadFromDisk).toHaveBeenCalledOnce();
    expect(w.syncFromSettings).toHaveBeenCalledOnce();
    expect(w.initTheme).not.toHaveBeenCalled();
  });

  it("does not repaint the theme when the reload was a no-op", async () => {
    const w = await wired({ reloadResult: false });
    await w.handleConfigFileChanged("settings.json");
    expect(w.reloadFromDisk).toHaveBeenCalledOnce();
    expect(w.syncFromSettings).not.toHaveBeenCalled();
  });

  it("re-injects user theme CSS when a themes/*.css file changes", async () => {
    const w = await wired({ reloadResult: false });
    await w.handleConfigFileChanged("themes/midnight.css");
    expect(w.initTheme).toHaveBeenCalledOnce();
    expect(w.reloadFromDisk).not.toHaveBeenCalled();
  });

  it("ignores config files nothing reacts to", async () => {
    const w = await wired({ reloadResult: true });
    await w.handleConfigFileChanged("bookmarks.json");
    expect(w.reloadFromDisk).not.toHaveBeenCalled();
    expect(w.initTheme).not.toHaveBeenCalled();
    expect(w.syncFromSettings).not.toHaveBeenCalled();
  });
});
