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
vi.mock("$lib/api/crash", async (original) => ({
  ...(await original<typeof import("$lib/api/crash")>()),
  logFrontendError: vi.fn(async () => {}),
}));
vi.mock("$lib/api/config", async (original) => {
  const actual = await original<typeof import("$lib/api/config")>();
  return { ...actual, readConfigFile: vi.fn(actual.readConfigFile) };
});

import { createPluginRegistry } from "$lib/plugins/registry.svelte";
import type { Plugin, PluginContext } from "$lib/plugins/api";
import { executeCommand, getCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { createPluginJobsController } from "$lib/state/plugin-jobs";
import { pluginSettingsSections } from "$lib/plugins/settings-registry.svelte";
import { logFrontendError } from "$lib/api/crash";
import { readConfigFile } from "$lib/api/config";
import { upscalePlugin } from "$lib/plugins/upscale";
import type { FileEntry } from "$lib/domain/file";

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
  vi.mocked(logFrontendError).mockClear();
});

afterEach(() => {
  toastStore.clear();
  contextMenuItems.clear();
  pluginSettingsSections.clear();
});

/** Tauri rejects a failed command with its serialized AppError. */
const backendError = (message: string) => ({ kind: "other", message });

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
          handler: async () => { throw backendError("service unavailable"); },
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
      // The failure also reaches the app log, which a report can include.
      expect(vi.mocked(logFrontendError).mock.calls.map(([message]) => message)).toEqual([
        expect.stringContaining('"quota" command plugin.quota.cmd failed: quota exceeded'),
        expect.stringContaining('"quota" menu action plugin.quota.item failed: service unavailable'),
      ]);

      expect(await executeCommand("plugin.bystander.cmd")).toBe(true);
      expect(healthy.runs).toEqual(["bystander"]);
      expect(registry.isActive("quota")).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it("reports a built-in plugin's asynchronous handler failure under its name", async () => {
    // A handler that starts work and drops the promise hides every later
    // failure from the context that reports it.
    const registry = createPluginRegistry([upscalePlugin], jobs);
    const image: FileEntry = { name: "photo.png", path: "/home/user/photo.png", kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" };
    try {
      await registry.initPlugins();
      // The handler reads the API key before it opens the dialog.
      vi.mocked(readConfigFile).mockRejectedValueOnce(backendError("config directory unreadable"));

      const item = contextMenuItems.items.find((candidate) => candidate.id === "upscale.run");
      await item!.handler([image]);

      expect(errorToasts()).toEqual(["Upscale: config directory unreadable"]);
    } finally {
      await registry.dispose();
    }
  });

  it("places contributions by plugin list position, whichever activation finishes first", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const contributing = (id: string, gate: Promise<void>): Plugin => ({
      id,
      name: id,
      description: "registers after reading its storage",
      activate: async (ctx) => {
        await gate;
        ctx.registerContextMenuItem({ id: `${id}.item`, label: id, when: () => true, handler: () => {} });
        ctx.registerSettingsSection({ id, title: id, rows: [] });
      },
    });
    const registry = createPluginRegistry(
      [contributing("first", firstGate), contributing("second", Promise.resolve())],
      jobs,
    );
    try {
      const initialization = registry.initPlugins();
      await vi.waitFor(() => expect(registry.isActive("second")).toBe(true));
      releaseFirst();
      await initialization;

      expect(contextMenuItems.items.map((item) => item.id)).toEqual(["first.item", "second.item"]);
      expect(pluginSettingsSections.sections.map((section) => section.id)).toEqual(["first", "second"]);

      // A re-enabled plugin returns to its own place, not the end.
      await registry.setEnabled("first", false);
      await registry.setEnabled("first", true);
      expect(contextMenuItems.items.map((item) => item.id)).toEqual(["first.item", "second.item"]);
    } finally {
      await registry.dispose();
    }
  });

  it("never activates a plugin that an earlier plugin disabled during startup", async () => {
    const activated: string[] = [];
    let registry!: ReturnType<typeof createPluginRegistry>;
    const disabler: Plugin = {
      id: "disabler",
      name: "Disabler",
      description: "turns the next plugin off while activating",
      activate: () => {
        activated.push("disabler");
        void registry.setEnabled("target", false);
      },
    };
    const target: Plugin = {
      id: "target",
      name: "Target",
      description: "must not run once disabled",
      activate: () => { activated.push("target"); },
    };
    registry = createPluginRegistry([disabler, target], jobs);
    try {
      await registry.initPlugins();
      expect(activated).toEqual(["disabler"]);
      expect(registry.isActive("target")).toBe(false);
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
