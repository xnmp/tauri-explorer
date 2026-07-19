/**
 * settingsStore init/update contracts (#280).
 *
 * The subtle rule under test: on init(), a valid config FILE wins over
 * whatever localStorage holds (and is mirrored back into localStorage);
 * with no config file, localStorage survives and is migrated to the file.
 * update() must merge partially and persist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readConfigFileMock = vi.fn();
const writeConfigQueuedMock = vi.fn();

vi.mock("$lib/api/files", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    readConfigFile: (...args: unknown[]) => readConfigFileMock(...args),
  };
});

vi.mock("$lib/state/persisted", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    writeConfigQueued: (...args: unknown[]) => writeConfigQueuedMock(...args),
  };
});

async function freshStore() {
  vi.resetModules();
  const mod = await import("$lib/state/settings.svelte");
  return mod.settingsStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("settingsStore.init precedence (#280)", () => {
  it("a valid config file overrides localStorage and is mirrored back to it", async () => {
    localStorage.setItem("explorer-settings", JSON.stringify({ showHidden: true, zoomLevel: 150 }));
    readConfigFileMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ showHidden: false, zoomLevel: 120 }),
    });
    const store = await freshStore();

    await store.init();

    expect(store.showHidden).toBe(false);
    expect(store.zoomLevel).toBe(120);
    // Mirrored: localStorage now matches the file, not its stale pre-init value.
    const mirrored = JSON.parse(localStorage.getItem("explorer-settings")!);
    expect(mirrored.zoomLevel).toBe(120);
  });

  it("without a config file, localStorage values survive and migrate to the file", async () => {
    localStorage.setItem("explorer-settings", JSON.stringify({ showHidden: true }));
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    await store.init();

    expect(store.showHidden).toBe(true);
    expect(writeConfigQueuedMock).toHaveBeenCalledWith("settings.json", expect.any(String));
  });

  it("a corrupt config file falls back to localStorage instead of throwing", async () => {
    localStorage.setItem("explorer-settings", JSON.stringify({ showHidden: true }));
    readConfigFileMock.mockResolvedValue({ ok: true, data: "{not json" });
    const store = await freshStore();

    await expect(store.init()).resolves.toBeUndefined();
    expect(store.showHidden).toBe(true);
  });

  it("unknown keys in the config file don't clobber defaults for known ones", async () => {
    readConfigFileMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ someFutureSetting: 42 }),
    });
    const store = await freshStore();

    await store.init();

    // Defaults intact for everything the file didn't set.
    expect(store.showSidebar).toBe(true);
    expect(store.floatingIslands).toBe(false);
  });
});

describe("settingsStore.islandMode (#434)", () => {
  it("is off by default and turns on for any single island trigger", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();
    expect(store.islandMode).toBe(false);

    store.update({ floatingIslands: true });
    expect(store.islandMode).toBe(true);

    store.update({ floatingIslands: false, macOsVibrancy: true });
    expect(store.islandMode).toBe(true);

    store.update({ macOsVibrancy: false, windowsBackdrop: "mica" });
    expect(store.islandMode).toBe(true);

    store.update({ windowsBackdrop: "off" });
    expect(store.islandMode).toBe(false);
  });
});

describe("settingsStore preview pane position (#460)", () => {
  it("defaults to 'right'", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();
    expect(store.previewPanePosition).toBe("right");
  });

  it("setPreviewPanePosition validates and coerces unknown values to 'right'", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    store.setPreviewPanePosition("bottom");
    expect(store.previewPanePosition).toBe("bottom");

    store.setPreviewPanePosition("nonsense");
    expect(store.previewPanePosition).toBe("right");
  });

  it("cyclePreviewPanePosition steps right -> bottom -> top -> auto -> right (#467 adds auto)", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    store.cyclePreviewPanePosition();
    expect(store.previewPanePosition).toBe("bottom");
    store.cyclePreviewPanePosition();
    expect(store.previewPanePosition).toBe("top");
    store.cyclePreviewPanePosition();
    expect(store.previewPanePosition).toBe("auto");
    store.cyclePreviewPanePosition();
    expect(store.previewPanePosition).toBe("right");
  });

  it("reading the getter repairs a malformed persisted value without a write", async () => {
    localStorage.setItem("explorer-settings", JSON.stringify({ previewPanePosition: "sideways" }));
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();
    expect(store.previewPanePosition).toBe("right");
  });
});

describe("settingsStore auto dock mode (#467)", () => {
  it("setPreviewPanePosition accepts 'auto' and stores it as the raw mode", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    store.setPreviewPanePosition("auto");
    expect(store.previewPanePosition).toBe("auto");
  });

  it("resolvedPreviewPanePosition resolves 'auto' to a concrete edge instead of leaking 'auto' to layout", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    store.setPreviewPanePosition("auto");
    // No `window` global in this suite (node test environment) — the window
    // geometry inputs are degenerate (0x0), so resolution falls back to the
    // same safe default as malformed input, and — critically — the result is
    // always one of the three concrete edges, never "auto" itself.
    expect(store.resolvedPreviewPanePosition).toBe("right");
    expect(["right", "bottom", "top"]).toContain(store.resolvedPreviewPanePosition);
  });

  it("resolvedPreviewPanePosition passes concrete positions through unchanged", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    store.setPreviewPanePosition("bottom");
    expect(store.resolvedPreviewPanePosition).toBe("bottom");
    expect(store.previewPanePosition).toBe("bottom");
  });
});

describe("settingsStore preview pane size", () => {
  it("setPreviewPaneHeight clamps to 0..600", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    store.setPreviewPaneHeight(-50);
    expect(store.previewPaneHeight).toBe(0);
    store.setPreviewPaneHeight(999);
    expect(store.previewPaneHeight).toBe(600);
    store.setPreviewPaneHeight(300);
    expect(store.previewPaneHeight).toBe(300);
  });
});

describe("settingsStore.update (#280)", () => {
  it("merges partially and persists to localStorage", async () => {
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    const store = await freshStore();

    store.update({ showHidden: true });

    expect(store.showHidden).toBe(true);
    expect(store.showSidebar).toBe(true); // untouched key keeps its value
    const persisted = JSON.parse(localStorage.getItem("explorer-settings")!);
    expect(persisted.showHidden).toBe(true);
  });
});
