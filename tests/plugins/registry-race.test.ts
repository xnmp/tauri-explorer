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
vi.mock("$lib/plugins/ai-organize/AiOrganizeDialog.svelte", () => ({ default: {} }));

import { createPluginRegistry } from "$lib/plugins/registry.svelte";
import type { Plugin, PluginContext } from "$lib/plugins/api";
import { settingsStore } from "$lib/state/settings.svelte";
import { getCommand } from "$lib/state/commands.svelte";

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
  it("activates plugins without waiting for unused job event infrastructure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activate = vi.fn();
    const jobs = { init: vi.fn(() => gate), dispose: vi.fn(async () => {}) };
    const plugin: Plugin = {
      id: "independent-startup", name: "Independent", description: "test", enabledByDefault: true,
      activate,
    };
    const registry = createPluginRegistry([plugin], jobs);
    const initialization = registry.initPlugins();
    try {
      await Promise.resolve();
      expect(activate).toHaveBeenCalledOnce();
      expect(jobs.init).not.toHaveBeenCalled();
    } finally {
      release();
      await initialization;
      await registry.dispose();
    }
  });

  it("disable during in-flight activate tears the plugin down when it resolves", async () => {
    const { plugin, release, calls } = makeSlowPlugin("racer");
    const registry = createPluginRegistry([plugin]);

    const enabling = registry.setEnabled("racer", true); // activate() starts, awaits gate
    expect(getCommand("plugin.racer.cmd")).toBeDefined();
    await registry.setEnabled("racer", false); // lands mid-activate and disposes immediately
    expect(getCommand("plugin.racer.cmd")).toBeUndefined();

    release();
    await enabling;

    expect(registry.isActive("racer")).toBe(false);
    expect(calls).toContain("deactivate"); // hook ran for the torn-down activation
    expect(settingsStore.pluginsEnabled?.racer).toBe(false);
  });

  it("runs plugin cleanup when activation fails after partial acquisition", async () => {
    const calls: string[] = [];
    const plugin: Plugin = {
      id: "failure",
      name: "failure",
      description: "failure",
      enabledByDefault: false,
      activate(ctx) {
        ctx.registerCommand({
          id: "plugin.failure.cmd",
          label: "failure",
          category: "general",
          handler: () => {},
        });
        throw new Error("activation failed");
      },
      deactivate: () => calls.push("deactivate"),
    };
    const registry = createPluginRegistry([plugin]);

    await registry.setEnabled("failure", true);

    expect(registry.isActive("failure")).toBe(false);
    expect(getCommand("plugin.failure.cmd")).toBeUndefined();
    expect(calls).toEqual(["deactivate"]);
    await registry.setEnabled("failure", false);
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
    await registry.setEnabled("racer", false);
  });

  it("a final disable cancels a queued re-enable of an old activation", async () => {
    const { plugin, release, calls } = makeSlowPlugin("racer");
    const registry = createPluginRegistry([plugin]);

    const first = registry.setEnabled("racer", true);
    await registry.setEnabled("racer", false);
    const queuedEnable = registry.setEnabled("racer", true);
    await registry.setEnabled("racer", false);

    release();
    await Promise.all([first, queuedEnable]);

    expect(registry.isActive("racer")).toBe(false);
    expect(calls.filter((call) => call === "activate:start")).toHaveLength(1);
    expect(getCommand("plugin.racer.cmd")).toBeUndefined();
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

  it("terminal registry disposal drains activation and removes its contributions", async () => {
    const { plugin, release, calls } = makeSlowPlugin("racer");
    const jobs = { init: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const registry = createPluginRegistry([plugin], jobs);
    const enabling = registry.setEnabled("racer", true);
    expect(getCommand("plugin.racer.cmd")).toBeDefined();

    const disposing = registry.dispose();
    expect(registry.dispose()).toBe(disposing);
    expect(getCommand("plugin.racer.cmd")).toBeUndefined();
    release();
    await Promise.all([enabling, disposing]);

    expect(registry.isActive("racer")).toBe(false);
    expect(calls.filter((call) => call === "deactivate")).toHaveLength(1);
    expect(jobs.dispose).toHaveBeenCalledOnce();
    await registry.setEnabled("racer", true);
    expect(registry.isActive("racer")).toBe(false);
  });
});
