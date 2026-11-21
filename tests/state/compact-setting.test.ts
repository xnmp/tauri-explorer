/**
 * The `compact` density setting (#1878), which replaced the Compact layout
 * (#1548): off by default, persisted, migrated from `layoutTheme: "compact"`,
 * and painted on whatever layout is applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_CONFIG_SEED_KEY } from "$lib/api/mock-invoke";
import { CURRENT_SETTINGS_VERSION } from "$lib/domain/settings-migration";

/** Boot fresh stores whose settings loaded `config` from settings.json. */
async function bootWith(config: Record<string, unknown> | null, cache?: Record<string, unknown>) {
  if (config) localStorage.setItem(MOCK_CONFIG_SEED_KEY, JSON.stringify({ "settings.json": JSON.stringify(config) }));
  if (cache) localStorage.setItem("explorer-settings", JSON.stringify(cache));
  vi.resetModules();
  const { settingsStore } = await import("$lib/state/settings.svelte");
  const firstPaint = { layoutTheme: settingsStore.layoutTheme, compact: settingsStore.state.compact };
  await settingsStore.init();
  const { layoutStore } = await import("$lib/state/layout.svelte");
  return { settingsStore, layoutStore, firstPaint };
}

/** settings.json once the queued writes have settled. */
async function settledConfig(): Promise<Record<string, unknown>> {
  const { readConfigFile } = await import("$lib/api/config");
  let last = "";
  for (let turn = 0, stable = 0; turn < 200 && stable < 5; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await readConfigFile("settings.json");
    const now = result.ok ? (result.data ?? "") : "";
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  return JSON.parse(last) as Record<string, unknown>;
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("compact setting (#1878)", () => {
  it("is off by default, with the classic List row height", async () => {
    const { settingsStore, layoutStore } = await bootWith(null);
    expect(settingsStore.state.compact).toBe(false);
    expect(settingsStore.layoutTheme).toBe("default");
    expect(layoutStore.compact).toBe(false);
    expect(layoutStore.listRowHeight).toBe(30);
  });

  it("migrates the retired Compact layout to Default at compact density, and writes it back", async () => {
    const { settingsStore } = await bootWith({ layoutTheme: "compact", theme: "dark", settingsVersion: 3 });
    expect(settingsStore.layoutTheme).toBe("default");
    expect(settingsStore.state.compact).toBe(true);
    expect(settingsStore.state.theme).toBe("dark");
    expect(await settledConfig()).toMatchObject({ layoutTheme: "default", compact: true });
  });

  it("migrates the Compact layout even under the current migration stamp (a downgraded build wrote it)", async () => {
    const { settingsStore } = await bootWith({ layoutTheme: "compact", compact: false, settingsVersion: CURRENT_SETTINGS_VERSION });
    expect(settingsStore.layoutTheme).toBe("default");
    expect(settingsStore.state.compact).toBe(true);
  });

  it("paints the first frame from a cached Compact layout as Default at compact density", async () => {
    const { firstPaint } = await bootWith(null, { layoutTheme: "compact" });
    expect(firstPaint).toEqual({ layoutTheme: "default", compact: true });
  });

  it("leaves other layouts and an explicit choice alone", async () => {
    const { settingsStore } = await bootWith({ layoutTheme: "hairline-ledger", compact: true, settingsVersion: CURRENT_SETTINGS_VERSION });
    expect(settingsStore.layoutTheme).toBe("hairline-ledger");
    expect(settingsStore.state.compact).toBe(true);
  });

  it.each([["yes"], [1], [null], [{}]])("rejects a malformed persisted value (%j)", async (value) => {
    const { settingsStore } = await bootWith({ compact: value, settingsVersion: CURRENT_SETTINGS_VERSION });
    expect(settingsStore.state.compact).toBe(false);
  });

  it("persists across store initialization", async () => {
    let { settingsStore } = await bootWith(null);
    settingsStore.update({ compact: true });
    expect(await settledConfig()).toMatchObject({ compact: true });
    localStorage.removeItem(MOCK_CONFIG_SEED_KEY);
    ({ settingsStore } = await bootWith(null));
    expect(settingsStore.state.compact).toBe(true);
  });

  // The root attribute and the density sheet are painted in the browser
  // (e2e/layout-themes.spec.ts); the unit suite has no DOM.
  it("sizes List rows from the applied density, which survives a restart", async () => {
    let { layoutStore } = await bootWith(null);
    layoutStore.commit({ id: "soft-cards", base: "soft-cards", sheets: [], rowHeight: 22, compact: true });
    expect(layoutStore.compact).toBe(true);
    expect(layoutStore.listRowHeight).toBe(26);

    // The applied layout is cached for first paint, density included.
    ({ layoutStore } = await bootWith(null, { layoutTheme: "soft-cards", compact: true }));
    expect(layoutStore.applied).toMatchObject({ id: "soft-cards", compact: true, rowHeight: 22 });

    layoutStore.commit({ id: "soft-cards", base: "soft-cards", sheets: [], rowHeight: 28, compact: false });
    expect(layoutStore.listRowHeight).toBe(30);
  });

  it("does not reuse a cached layout painted at the other density", async () => {
    let { layoutStore } = await bootWith(null);
    layoutStore.commit({ id: "soft-cards", base: "soft-cards", sheets: ["a{}"], rowHeight: 22, compact: true });
    ({ layoutStore } = await bootWith(null, { layoutTheme: "soft-cards", compact: false }));
    expect(layoutStore.applied).toMatchObject({ id: "soft-cards", compact: false, sheets: [] });
  });

  it("is a palette toggle that flips the setting", async () => {
    const { settingsStore } = await bootWith(null);
    const { generateToggleCommands } = await import("$lib/state/settings-toggles");
    const command = generateToggleCommands().find((c) => c.id === "view.toggleCompact")!;
    expect(command.toggleState?.()).toBe(false);
    void command.handler();
    expect(settingsStore.state.compact).toBe(true);
    expect(command.toggleState?.()).toBe(true);
  });
});
