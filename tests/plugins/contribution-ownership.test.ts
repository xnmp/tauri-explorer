import { afterEach, expect, it } from "vitest";
import type { Component } from "svelte";
import { createPluginContext } from "$lib/plugins/api";
import { getCommand, registerCommand, unregisterCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { clearFsProviders, providerFor, registerFsProvider } from "$lib/plugins/fs-providers";

const command = { id: "ownership-test", label: "Core", category: "general" as const, handler() {} };
afterEach(() => { unregisterCommand(command.id); contextMenuItems.clear(); dialogRegistry.clear(); clearFsProviders(); });
it("rejects a plugin command collision without replacing the core command", () => {
  registerCommand(command);
  const plugin = createPluginContext("ownership");
  expect(() => plugin.ctx.registerCommand({ ...command, label: "Plugin" })).toThrow();
  plugin.dispose();
  expect(getCommand(command.id)?.label).toBe("Core");
});
it("plugin disposal cannot delete a command subsequently replaced by core", () => {
  const plugin = createPluginContext("ownership");
  plugin.ctx.registerCommand(command);
  registerCommand({ ...command, label: "Replacement" });
  plugin.dispose();
  expect(getCommand(command.id)?.label).toBe("Replacement");
});
it("late plugin contributions cannot survive disposal", () => {
  const plugin = createPluginContext("ownership");
  plugin.dispose();
  plugin.ctx.registerCommand(command);
  expect(getCommand(command.id)).toBeUndefined();
});
it("old menu disposers cannot delete re-registered items after clearing", () => {
  const item = { id: "menu", label: "Menu", when: () => true, handler() {} };
  const dispose = contextMenuItems.register(item);
  contextMenuItems.clear();
  contextMenuItems.register(item);
  dispose();
  expect(contextMenuItems.itemsFor([])).toHaveLength(1);
});
it("old dialog disposers cannot close a newly registered instance", () => {
  const descriptor = { id: "dialog", component: (() => {}) as unknown as Component };
  const dispose = dialogRegistry.register(descriptor);
  dialogRegistry.clear();
  dialogRegistry.register(descriptor);
  dialogRegistry.open(descriptor.id);
  dispose();
  expect(dialogRegistry.isOpen(descriptor.id)).toBe(true);
});
it("provider disposal distinguishes registrations of the same object", () => {
  const provider = { list: (path: string) => ({ path, entries: [], listing_id: null }) };
  const dispose = registerFsProvider("owned", provider);
  registerFsProvider("owned", provider);
  dispose();
  expect(providerFor("owned://root")).toBe(provider);
});
it("rejects plugin provider collisions without replacing the existing provider", () => {
  const core = { list: (path: string) => ({ path, entries: [], listing_id: null }) };
  registerFsProvider("owned", core);
  const plugin = createPluginContext("ownership");
  expect(() => plugin.ctx.registerFsProvider("OWNED", {
    list: (path: string) => ({ path, entries: [], listing_id: null }),
  })).toThrow();
  plugin.dispose();
  expect(providerFor("owned://root")).toBe(core);
});
