/**
 * Plugin failure isolation (#782): each failure stays with the plugin that
 * caused it while another plugin is active.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The registry statically imports the built-in plugins, which pull in Svelte
// dialog components; stub them so the node-env test doesn't compile Svelte.
vi.mock("$lib/plugins/nano-banana/NanoBananaDialog.svelte", () => ({ default: {} }));
vi.mock("$lib/plugins/ai-rename/AiRenameDialog.svelte", () => ({ default: {} }));
vi.mock("$lib/plugins/ai-organize/AiOrganizeDialog.svelte", () => ({ default: {} }));

import { createPluginRegistry } from "$lib/plugins/registry.svelte";
import type { Plugin, PluginContext } from "$lib/plugins/api";
import { executeCommand, getCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { createPluginJobsController } from "$lib/state/plugin-jobs";

const jobs = { dispose: vi.fn(async () => {}) };

/** A healthy plugin with one command that records its runs. */
function healthyPlugin(id: string) {
  const runs: string[] = [];
  const plugin: Plugin = {
    id,
    name: `Healthy ${id}`,
    description: "test plugin",
    activate: (ctx: PluginContext) => {
      ctx.registerCommand({ id: `plugin.${id}.cmd`, label: id, category: "general", handler: () => { runs.push(id); } });
    },
  };
  return { plugin, runs };
}

const errorToasts = () => toastStore.toasts.filter((toast) => toast.type === "error").map((toast) => toast.message);

beforeEach(() => {
  localStorage.clear();
  toastStore.clear();
});

afterEach(() => {
  toastStore.clear();
  contextMenuItems.clear();
});

describe("plugin failure isolation", () => {
  it("keeps other plugins working when one activation throws, and retries it on enable", async () => {
    const healthy = healthyPlugin("steady");
    let attempts = 0;
    const failing: Plugin = {
      id: "brittle",
      name: "Brittle",
      description: "throws on its first activation",
      activate: (ctx) => {
        attempts += 1;
        ctx.registerCommand({ id: "plugin.brittle.cmd", label: "Brittle", category: "general", handler: () => {} });
        if (attempts === 1) throw new Error("activation failed");
      },
    };
    const registry = createPluginRegistry([failing, healthy.plugin], jobs);
    try {
      await registry.initPlugins();

      expect(registry.isActive("brittle")).toBe(false);
      expect(getCommand("plugin.brittle.cmd"), "a failed activation keeps no contributions").toBeUndefined();
      expect(registry.isActive("steady")).toBe(true);
      expect(await executeCommand("plugin.steady.cmd")).toBe(true);
      expect(healthy.runs).toEqual(["steady"]);

      await registry.setEnabled("brittle", true);
      expect(registry.isActive("brittle")).toBe(true);
      expect(getCommand("plugin.brittle.cmd")).toBeDefined();
    } finally {
      await registry.dispose();
    }
  });

  it("does not hold other plugins behind an activation that never settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hung: Plugin = {
      id: "hung",
      name: "Hung",
      description: "awaits storage that never answers",
      activate: () => gate,
    };
    const healthy = healthyPlugin("after-hung");
    const registry = createPluginRegistry([hung, healthy.plugin], jobs);
    const initialization = registry.initPlugins();
    try {
      await vi.waitFor(() => expect(registry.isActive("after-hung")).toBe(true), { timeout: 500 });
      expect(await executeCommand("plugin.after-hung.cmd")).toBe(true);
      expect(registry.isActive("hung")).toBe(false);
    } finally {
      release();
      await initialization;
      await registry.dispose();
    }
  });

  it("reports a rejected plugin command and menu action, naming the plugin, without affecting others", async () => {
    const healthy = healthyPlugin("bystander");
    const failing: Plugin = {
      id: "quota",
      name: "Quota Plugin",
      description: "its service rejects every request",
      activate: (ctx) => {
        ctx.registerCommand({
          id: "plugin.quota.cmd",
          label: "Quota",
          category: "general",
          handler: async () => { throw new Error("quota exceeded"); },
        });
        ctx.registerContextMenuItem({
          id: "plugin.quota.item",
          label: "Quota item",
          when: () => true,
          handler: async () => { throw new Error("service unavailable"); },
        });
      },
    };
    const registry = createPluginRegistry([failing, healthy.plugin], jobs);
    try {
      await registry.initPlugins();

      expect(await executeCommand("plugin.quota.cmd")).toBe(false);
      expect(errorToasts()).toEqual(["Quota Plugin: quota exceeded"]);

      // ContextMenu fires handlers without awaiting them, so a reported
      // failure must not also escape as an unhandled rejection.
      const item = contextMenuItems.items.find((candidate) => candidate.id === "plugin.quota.item");
      await expect(Promise.resolve(item!.handler([]))).resolves.toBeUndefined();
      expect(errorToasts()).toEqual(["Quota Plugin: service unavailable"]);

      expect(await executeCommand("plugin.bystander.cmd")).toBe(true);
      expect(healthy.runs).toEqual(["bystander"]);
      expect(registry.isActive("quota")).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it("fails only the job that timed out while another plugin's job keeps running", async () => {
    const handlers = new Map<string, (payload: never) => void>();
    const deps = {
      listen: vi.fn(async <T,>(name: string, handler: (payload: T) => void) => {
        handlers.set(name, handler as (payload: never) => void);
        return () => handlers.delete(name);
      }),
      add: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      refresh: vi.fn(async () => {}),
    };
    const controller = createPluginJobsController(deps);
    const emit = (name: string, payload: unknown) => handlers.get(name)!(payload as never);
    try {
      expect(await controller.accept({ kind: "upscale", label: "Upscale", detail: "a.png" }, async () => ({ ok: true, data: 1 }))).toEqual({ ok: true, data: 1 });
      expect(await controller.accept({ kind: "nano-banana", label: "Nano Banana", detail: "b.png" }, async () => ({ ok: true, data: 2 }))).toEqual({ ok: true, data: 2 });

      emit("nano-banana-error", { jobId: 2, error: "timed out after 120 s" });
      expect(deps.fail).toHaveBeenCalledExactlyOnceWith(2, "timed out after 120 s");
      expect(deps.error).toHaveBeenCalledExactlyOnceWith("Nano Banana failed: timed out after 120 s");
      expect(deps.complete).not.toHaveBeenCalled();

      emit("upscale-complete", { jobId: 1, outputPath: "/pictures/a-upscaled.png" });
      expect(deps.complete).toHaveBeenCalledExactlyOnceWith(1, "/pictures/a-upscaled.png");
      expect(deps.success).toHaveBeenCalledExactlyOnceWith("Upscale complete: a-upscaled.png");
      expect(deps.fail).toHaveBeenCalledOnce();
    } finally {
      await controller.dispose();
    }
  });
});
