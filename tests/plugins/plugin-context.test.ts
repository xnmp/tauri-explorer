/**
 * Plugin lifecycle: contributions registered on activate are all disposed on
 * deactivate (src/lib/plugins/api.ts createPluginContext).
 */

import { describe, it, expect } from "vitest";
import { createPluginContext, type PluginContext } from "$lib/plugins/api";
import { getAllCommands, getCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { providerFor } from "$lib/plugins/fs-providers";
import type { FileEntry } from "$lib/domain/file";

const fileEntry: FileEntry = {
  name: "x.txt",
  path: "/x.txt",
  kind: "file",
  size: 1,
  modified: "2024-01-01T00:00:00.000Z",
};

function activate(ctx: PluginContext): void {
  ctx.registerCommand({
    id: "test.plugin.cmd",
    label: "Test Command",
    category: "plugins",
    handler: () => {},
  });
  ctx.registerContextMenuItem({
    id: "test.plugin.item",
    label: "Test Item",
    when: (entries) => entries.length > 0,
    handler: () => {},
  });
  ctx.registerFsProvider("testscheme", {
    list: (p) => ({ path: p, entries: [], listing_id: null }),
  });
}

describe("plugin lifecycle", () => {
  it("registers all contributions on activate and removes them on dispose", () => {
    const { ctx, dispose } = createPluginContext("testplugin");
    activate(ctx);

    // Command visible in the registry.
    expect(getCommand("test.plugin.cmd")).toBeDefined();
    expect(getAllCommands().some((c) => c.id === "test.plugin.cmd")).toBe(true);

    // Context-menu item shows for a non-empty selection.
    expect(contextMenuItems.itemsFor([fileEntry]).some((i) => i.id === "test.plugin.item")).toBe(true);

    // Fs provider dispatches for its scheme.
    expect(providerFor("testscheme://root")).not.toBeNull();

    dispose();

    // Everything gone.
    expect(getCommand("test.plugin.cmd")).toBeUndefined();
    expect(getAllCommands().some((c) => c.id === "test.plugin.cmd")).toBe(false);
    expect(contextMenuItems.itemsFor([fileEntry]).some((i) => i.id === "test.plugin.item")).toBe(false);
    expect(providerFor("testscheme://root")).toBeNull();
  });

  it("context-menu item respects its when predicate", () => {
    const { ctx, dispose } = createPluginContext("testplugin2");
    ctx.registerContextMenuItem({
      id: "test.plugin.selonly",
      label: "Selection Only",
      when: (entries) => entries.length > 0,
      handler: () => {},
    });
    expect(contextMenuItems.itemsFor([]).some((i) => i.id === "test.plugin.selonly")).toBe(false);
    expect(contextMenuItems.itemsFor([fileEntry]).some((i) => i.id === "test.plugin.selonly")).toBe(true);
    dispose();
  });
});
