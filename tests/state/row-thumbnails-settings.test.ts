/**
 * The `rowThumbnails` setting (#1465): off by default, persisted, and the one
 * input the shared layout store uses to choose Details and List row heights.
 */
import { expect, it, vi } from "vitest";
vi.mock("$lib/api/config", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readConfigFile: async () => ({ ok: true, data: null }) }));
vi.mock("$lib/state/persisted", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), writeConfigQueued: vi.fn() }));

async function freshStores() {
  vi.resetModules();
  const { settingsStore } = await import("$lib/state/settings.svelte");
  await settingsStore.init();
  const { layoutStore } = await import("$lib/state/layout.svelte");
  return { settingsStore, layoutStore };
}

it("is off by default, leaving the classic row heights", async () => {
  localStorage.clear();
  const { settingsStore, layoutStore } = await freshStores();
  expect(settingsStore.state.rowThumbnails).toBe(false);
  expect(layoutStore.detailsRowHeight).toBe(32);
  expect(layoutStore.listRowHeight).toBe(30);
});

it("turning it on raises both row heights and persists across store initialization", async () => {
  localStorage.clear();
  let { settingsStore, layoutStore } = await freshStores();
  settingsStore.update({ rowThumbnails: true });
  expect(layoutStore.detailsRowHeight).toBe(58);
  expect(layoutStore.listRowHeight).toBe(62);
  expect(JSON.parse(localStorage.getItem("explorer-settings")!).rowThumbnails).toBe(true);

  ({ settingsStore, layoutStore } = await freshStores());
  expect(settingsStore.state.rowThumbnails).toBe(true);
  expect(layoutStore.detailsRowHeight).toBe(58);
});

it("keeps the layout theme's own row height separate from the thumbnail raise", async () => {
  localStorage.clear();
  const { settingsStore, layoutStore } = await freshStores();
  settingsStore.update({ rowThumbnails: true });
  layoutStore.setRowHeight(64);
  expect(layoutStore.detailsRowHeight).toBe(64);
  layoutStore.setRowHeight(28);
  expect(layoutStore.applied.rowHeight).toBe(28);
  expect(layoutStore.detailsRowHeight).toBe(58);
  settingsStore.update({ rowThumbnails: false });
  expect(layoutStore.detailsRowHeight).toBe(28);
});

it("rejects a malformed persisted value", async () => {
  localStorage.clear();
  localStorage.setItem("explorer-settings", JSON.stringify({ rowThumbnails: "yes" }));
  const { settingsStore } = await freshStores();
  expect(settingsStore.state.rowThumbnails).toBe(false);
});

it("is a palette toggle", async () => {
  const { TOGGLE_SETTINGS } = await import("$lib/state/settings.svelte");
  expect(TOGGLE_SETTINGS.some(meta => meta.key === "rowThumbnails")).toBe(true);
});
