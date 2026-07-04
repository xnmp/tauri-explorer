/**
 * Plugin registry lifecycle races (#151): a disable arriving while a
 * plugin's async activate() is still awaiting must not leave the plugin
 * registered once the activation resolves.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// The registry statically imports the built-in plugins, which pull in Svelte
// dialog components; stub them so the node-env test doesn't compile Svelte.
vi.mock("$lib/plugins/nano-banana/NanoBananaDialog.svelte", () => ({ default: {} }));
vi.mock("$lib/plugins/ai-rename/AiRenameDialog.svelte", () => ({ default: {} }));

import { createPluginRegistry } from "$lib/plugins/registry.svelte";
import type { Plugin, PluginContext } from "$lib/plugins/api";
import { settingsStore } from "$lib/state/settings.svelte";

/** A plugin whose activate() blocks until the test releases it. */
function makeSlowPlugin(id: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const plugin: Plugin = {
    id,
    name: id,
    description: "test plugin",
    enabledByDefault: false,
    activate: async (ctx: PluginContext) => {
      calls.push("activate:start");
      ctx.registerCommand({ id: `plugin.${id}.cmd`, label: id, category: "general", handler: () => {} });
      await gate;
      calls.push("activate:end");
    },
    deactivate: () => calls.push("deactivate"),
  };
  return { plugin, release: () => release(), calls };
}

beforeEach(() => {
  localStorage.clear();
});

describe("plugin registry activation race", () => {
  it("disable during in-flight activate tears the plugin down when it resolves", async () => {
    const { plugin, release, calls } = makeSlowPlugin("racer");
    const registry = createPluginRegistry([plugin]);

    const enabling = registry.setEnabled("racer", true); // activate() starts, awaits gate
    await registry.setEnabled("racer", false); // lands mid-activate: no-op on `active`

    release();
    await enabling;

    expect(registry.isActive("racer")).toBe(false);
    expect(calls).toContain("deactivate"); // hook ran for the torn-down activation
    expect(settingsStore.pluginsEnabled?.racer).toBe(false);
  });

  it("re-enable while an activation is in flight reuses it and stays active", async () => {
    const { plugin, release } = makeSlowPlugin("racer");
    const registry = createPluginRegistry([plugin]);

    const first = registry.setEnabled("racer", true);
    void registry.setEnabled("racer", false);
    const second = registry.setEnabled("racer", true); // joins the in-flight activate

    release();
    await Promise.all([first, second]);

    expect(registry.isActive("racer")).toBe(true);
  });

  it("plain enable then disable still works", async () => {
    const { plugin, release, calls } = makeSlowPlugin("racer");
    const registry = createPluginRegistry([plugin]);

    const enabling = registry.setEnabled("racer", true);
    release();
    await enabling;
    expect(registry.isActive("racer")).toBe(true);

    await registry.setEnabled("racer", false);
    expect(registry.isActive("racer")).toBe(false);
    expect(calls.filter((c) => c === "deactivate")).toHaveLength(1);
  });
});
