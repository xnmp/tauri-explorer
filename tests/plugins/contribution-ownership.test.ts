import { afterEach, expect, it } from "vitest";
import type { Component } from "svelte";
import { createPluginContext } from "$lib/plugins/api";
import { getCommand, registerCommand, unregisterCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { inspectorRegistry } from "$lib/plugins/inspector-registry.svelte";
import { clearFsProviders, providerFor, registerFsProvider } from "$lib/plugins/fs-providers";

const command = { id: "ownership-test", label: "Core", category: "general" as const, handler() {} };
afterEach(() => { unregisterCommand(command.id); contextMenuItems.clear(); dialogRegistry.clear(); inspectorRegistry.clear(); clearFsProviders(); });
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
it("removes a plugin inspector when its owner deactivates", () => {
  const plugin = createPluginContext("ownership");
  plugin.ctx.registerInspector({
    id: "trace",
    title: "Trace",
    component: (() => {}) as unknown as Component,
    when: (entries) => entries.length === 1,
  });
  expect(inspectorRegistry.itemsFor([])).toHaveLength(0);
  expect(inspectorRegistry.itemsFor([{ name: "a.png", path: "/a.png", kind: "file", size: 1, modified: "" }])).toHaveLength(1);
  plugin.dispose();
  expect(inspectorRegistry.itemsFor([{ name: "a.png", path: "/a.png", kind: "file", size: 1, modified: "" }])).toHaveLength(0);
});
it("provider disposal distinguishes registrations of the same object", () => {
  const provider = { list: (path: string) => ({ path, entries: [] }) };
  const dispose = registerFsProvider("owned", provider);
  registerFsProvider("owned", provider);
  dispose();
  expect(providerFor("owned://root")).toBe(provider);
});
it("rejects plugin provider collisions without replacing the existing provider", () => {
  const core = { list: (path: string) => ({ path, entries: [] }) };
  registerFsProvider("owned", core);
  const plugin = createPluginContext("ownership");
  expect(() => plugin.ctx.registerFsProvider("OWNED", {
    list: (path: string) => ({ path, entries: [] }),
  })).toThrow();
  plugin.dispose();
  expect(providerFor("owned://root")).toBe(core);
});
