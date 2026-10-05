import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Component } from "svelte";

vi.mock("$lib/plugins/nano-banana/NanoBananaDialog.svelte", () => ({ default: {} }));
vi.mock("$lib/plugins/ai-rename/AiRenameDialog.svelte", () => ({ default: {} }));
vi.mock("$lib/plugins/ai-organize/AiOrganizeDialog.svelte", () => ({ default: {} }));

import { createPluginRegistry } from "$lib/plugins/registry.svelte";
import type { Plugin } from "$lib/plugins/api";
import { getCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { pluginSettingsSections } from "$lib/plugins/settings-registry.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { clearFsProviders, providerFor } from "$lib/plugins/fs-providers";

const dialogComponent = (() => {}) as unknown as Component;
const entry = {
  name: "fixture.txt",
  path: "/fixture.txt",
  kind: "file" as const,
  size: 1,
  modified: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
  contextMenuItems.clear();
  pluginSettingsSections.clear();
  dialogRegistry.clear();
  clearFsProviders();
});

describe("plugin registry churn", () => {
  it("orders installed settings after built-ins regardless of activation completion", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const plugin = (id: string, wait?: Promise<void>): Plugin => ({
      id, name: id, description: "ordering contract",
      async activate(ctx) {
        if (wait) await wait;
        ctx.registerSettingsSection({ id: "settings", title: id, rows: [] });
      },
    });
    const registry = createPluginRegistry([plugin("builtin")]);
    try {
      await registry.initPlugins();
      const installing = registry.registerInstalled([
        plugin("installed-slow", held), plugin("installed-fast"),
      ]);
      release();
      await installing;
      const titles = () => pluginSettingsSections.sections.map(section => section.title);
      expect(titles()).toEqual(["builtin", "installed-slow", "installed-fast"]);
      await registry.setEnabled("installed-slow", false);
      await registry.setEnabled("installed-slow", true);
      expect(titles()).toEqual(["builtin", "installed-slow", "installed-fast"]);
    } finally {
      release();
      await registry.dispose();
    }
  });

  it("keeps surviving contribution order when earlier packages are removed", async () => {
    const plugin = (id: string): Plugin => ({
      id, name: id, description: "ordering contract",
      activate(ctx) { ctx.registerSettingsSection({ id: "settings", title: id, rows: [] }); },
    });
    const registry = createPluginRegistry([plugin("builtin")]);
    try {
      await registry.initPlugins();
      await registry.registerInstalled([plugin("a"), plugin("b"), plugin("c")]);
      await registry.removeInstalled(["a", "b"]);
      await registry.registerInstalled([plugin("d")]);
      const titles = () => pluginSettingsSections.sections.map(section => section.title);
      expect(titles()).toEqual(["builtin", "c", "d"]);
      await registry.setEnabled("c", false);
      await registry.setEnabled("c", true);
      expect(titles()).toEqual(["builtin", "c", "d"]);
      await expect(registry.registerInstalled([plugin("duplicate"), plugin("duplicate")]))
        .rejects.toThrow("Plugin ID is already registered");
      expect(titles()).toEqual(["builtin", "c", "d"]);
    } finally {
      await registry.dispose();
    }
  });

  it("leaves no duplicate or retained effects across 5,001 mixed activations", async () => {
    const calls = { alpha: 0, beta: 0, failing: 0 };
    const alpha: Plugin = {
      id: "churn-alpha", name: "alpha", description: "test", enabledByDefault: false,
      activate(ctx) {
        calls.alpha++;
        ctx.registerCommand({
          id: "plugin.churn-alpha.cmd", label: "alpha", category: "plugins", handler: () => {},
        });
        ctx.registerContextMenuItem({
          id: "plugin.churn-alpha.menu", label: "alpha", when: () => true, handler: () => {},
        });
      },
    };
    const beta: Plugin = {
      id: "churn-beta", name: "beta", description: "test", enabledByDefault: false,
      activate(ctx) {
        calls.beta++;
        ctx.registerFsProvider("churn-beta", {
          list: (path) => ({ path, entries: [] }),
        });
        ctx.registerDialog({ id: "churn-beta.dialog", component: dialogComponent });
      },
    };
    const failing: Plugin = {
      id: "churn-failing", name: "failing", description: "test", enabledByDefault: false,
      activate(ctx) {
        calls.failing++;
        ctx.registerSettingsSection({
          id: "churn-failing.settings", title: "Failure", rows: [],
        });
        throw new Error("expected churn activation failure");
      },
    };
    const jobs = { dispose: vi.fn(async () => {}) };
    const registry = createPluginRegistry([alpha, beta, failing], jobs);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const iterations = 1_667;

    try {
      for (let cycle = 0; cycle < iterations; cycle++) {
        await Promise.all([
          registry.setEnabled(alpha.id, true),
          registry.setEnabled(beta.id, true),
          registry.setEnabled(failing.id, true),
        ]);

        expect(getCommand("plugin.churn-alpha.cmd")).toBeDefined();
        expect(contextMenuItems.itemsFor([entry]).filter((item) => item.id === "plugin.churn-alpha.menu")).toHaveLength(1);
        expect(providerFor("churn-beta://root")).not.toBeNull();
        dialogRegistry.open("churn-beta.dialog");
        expect(dialogRegistry.isOpen("churn-beta.dialog")).toBe(true);
        expect(pluginSettingsSections.sections.filter((section) =>
          section.pluginId === failing.id)).toHaveLength(0);

        await Promise.all([
          registry.setEnabled(alpha.id, false),
          registry.setEnabled(beta.id, false),
          registry.setEnabled(failing.id, false),
        ]);
        expect(getCommand("plugin.churn-alpha.cmd")).toBeUndefined();
        expect(contextMenuItems.itemsFor([entry]).some((item) => item.id === "plugin.churn-alpha.menu")).toBe(false);
        expect(providerFor("churn-beta://root")).toBeNull();
        expect(dialogRegistry.isOpen("churn-beta.dialog")).toBe(false);
      }

      expect(calls).toEqual({ alpha: iterations, beta: iterations, failing: iterations });
      await registry.dispose();
      expect(jobs.dispose).toHaveBeenCalledOnce();
      expect(errors).toHaveBeenCalledTimes(iterations);
    } finally {
      errors.mockRestore();
      await registry.dispose();
    }
  });
});
