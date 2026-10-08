import { afterEach, expect, it } from "vitest";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { createPluginContext } from "$lib/plugins/api";

afterEach(() => dialogStore.closeAll());

it("switches between general, plugin and keyboard settings without stacking them", () => {
  dialogStore.openSettings();
  dialogStore.openPlugins();
  expect(dialogStore.isSettingsOpen).toBe(false);
  expect(dialogStore.isPluginsOpen).toBe(true);
  expect(dialogStore.hasModalOpen).toBe(true);
  dialogStore.openKeybindings();
  expect(dialogStore.isPluginsOpen).toBe(false);
  expect(dialogStore.isKeybindingsOpen).toBe(true);
  dialogStore.openPlugins();
  expect(dialogStore.isKeybindingsOpen).toBe(false);
  dialogStore.openSettings();
  expect(dialogStore.isPluginsOpen).toBe(false);
  expect(dialogStore.isSettingsOpen).toBe(true);
});

it("routes plugin settings actions to the dedicated menu and clears it on closeAll", () => {
  const { ctx, dispose } = createPluginContext("settings-navigation");
  try {
    dialogStore.openCommandPalette();
    ctx.openSettings();
    expect(dialogStore.isCommandPaletteOpen).toBe(false);
    expect(dialogStore.isPluginsOpen).toBe(true);
    expect(dialogStore.isSettingsOpen).toBe(false);
    dialogStore.closeAll();
    expect(dialogStore.isPluginsOpen).toBe(false);
    expect(dialogStore.hasModalOpen).toBe(false);
  } finally { dispose(); }
});
