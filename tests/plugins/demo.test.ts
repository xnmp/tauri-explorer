/**
 * Demo plugin runs entirely against the injected PluginContext (#291).
 *
 * Proves the plugin-context seam holds: the demo plugin's virtual-folder
 * navigation routes through `ctx.workspace.navigate`, not a direct
 * windowTabsManager import. The window/tab store is mocked to throw on access —
 * if the plugin regressed to touching it directly, this test would fail.
 */

import { describe, it, expect, vi } from "vitest";

// Any direct use of the window/tab store from plugin code would blow up here.
vi.mock("$lib/state/window-tabs.svelte", () => ({
  get windowTabsManager(): never {
    throw new Error("demo plugin must not import windowTabsManager (#291)");
  },
}));

import { demoPlugin } from "$lib/plugins/demo";
import type { PluginContext } from "$lib/plugins/api";
import type { Command } from "$lib/state/commands.svelte";
import type { ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import type { FileEntry } from "$lib/domain/file";

/** Minimal recording stub of the plugin context — no real app stores. */
function makeStubCtx() {
  const commands: Command[] = [];
  const contextMenu: ContextMenuItem[] = [];
  const navigated: string[] = [];
  const toasts: string[] = [];
  const providers: string[] = [];

  const ctx: PluginContext = {
    registerCommand: (c) => void commands.push(c),
    registerContextMenuItem: (i) => void contextMenu.push(i),
    registerSettingsSection: () => {},
    registerFsProvider: (scheme) => void providers.push(scheme),
    registerDialog: () => {},
    openDialog: () => {},
    closeDialog: () => {},
    jobs: { accept: (_registration, start) => start() },
    toast: { show: (m) => void toasts.push(m), error: (m) => void toasts.push(m) },
    events: { listen: () => {} },
    storage: { get: async () => ({}), set: async () => {} },
    workspace: {
      getSelection: () => [],
      getVisibleEntries: () => [],
      navigate: async (p) => void navigated.push(p),
      refreshPanes: async () => {},
      moveFile: async () => ({ ok: true }),
    },
    openSettings: () => {},
  };

  return { ctx, commands, contextMenu, navigated, toasts, providers };
}

const fileEntry: FileEntry = {
  name: "a.txt",
  path: "/a.txt",
  kind: "file",
  size: 1,
  modified: "2024-01-01T00:00:00.000Z",
};

describe("demo plugin: driven purely through PluginContext", () => {
  it("navigates the virtual folder via ctx.workspace, not a store import", async () => {
    const f = makeStubCtx();
    await demoPlugin.activate(f.ctx);

    const open = f.commands.find((c) => c.id === "plugin.demo.open");
    expect(open).toBeDefined();
    open!.handler();

    // The navigation went through the injected workspace seam.
    expect(f.navigated).toEqual(["demo://"]);
  });

  it("registers its contributions and drives them through the context", async () => {
    const f = makeStubCtx();
    await demoPlugin.activate(f.ctx);

    // Hello command → toast through ctx.
    f.commands.find((c) => c.id === "plugin.demo.hello")!.handler();
    expect(f.toasts).toContain("Hello from the demo plugin!");

    // Greet context item → toast naming the selection.
    const greet = f.contextMenu.find((i) => i.id === "plugin.demo.greet")!;
    expect(greet.when([fileEntry])).toBe(true);
    greet.handler([fileEntry]);
    expect(f.toasts.some((t) => t.includes("a.txt"))).toBe(true);

    // Virtual-fs provider registered for the demo:// scheme.
    expect(f.providers).toContain("demo");
  });
});
