import { expect, test, vi } from "vitest";
vi.mock("$lib/api/config", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readConfigFile: async () => ({ ok: true, data: null }) }));
vi.mock("$lib/state/persisted", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), writeConfigQueued: vi.fn() }));

test("old column preferences gain Resolution, and hiding persists across store initialization", async () => {
  localStorage.clear();
  localStorage.setItem("explorer-settings", JSON.stringify({ columnVisibility: { date: false, type: true, size: false } }));
  vi.resetModules();
  let { settingsStore } = await import("$lib/state/settings.svelte");
  await settingsStore.init();
  expect(settingsStore.columnVisibility).toEqual({ date: false, type: true, size: false, resolution: true });
  settingsStore.toggleColumn("resolution");
  expect(JSON.parse(localStorage.getItem("explorer-settings")!).columnVisibility.resolution).toBe(false);
  vi.resetModules();
  ({ settingsStore } = await import("$lib/state/settings.svelte"));
  await settingsStore.init();
  expect(settingsStore.columnVisibility.resolution).toBe(false);
});
