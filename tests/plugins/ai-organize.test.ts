/**
 * AI Organize plugin (#158): contribution surface, candidate gathering, and
 * key seeding from the ai-rename plugin's storage.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("$lib/plugins/ai-organize/AiOrganizeDialog.svelte", () => ({ default: {} }));

import { aiOrganizePlugin } from "$lib/plugins/ai-organize";
import { gatherCandidates, MAX_CANDIDATES } from "$lib/plugins/ai-organize";
import type { PluginContext, SettingsSectionDescriptor } from "$lib/plugins/api";
import type { ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import type { Command } from "$lib/state/commands.svelte";
import type { DialogDescriptor } from "$lib/plugins/dialog-registry.svelte";
import { writeConfigFile } from "$lib/api/config";
import type { FileEntry } from "$lib/domain/file";

function fileEntry(name: string, kind: "file" | "directory" = "file", dir = "/home/u"): FileEntry {
  return { name, path: `${dir}/${name}`, kind, size: 1, modified: "2024-01-01T00:00:00.000Z" } as FileEntry;
}

function makeFakeCtx(seedStorage: Record<string, unknown> = {}) {
  let store: Record<string, unknown> = { ...seedStorage };
  const commands: Command[] = [];
  const contextMenu: ContextMenuItem[] = [];
  const settingsSections: SettingsSectionDescriptor[] = [];
  const dialogs: DialogDescriptor[] = [];
  const jobs: PluginContext["jobs"] = { accept: (_registration, start) => start() };

  const ctx: PluginContext = {
    registerCommand: (c: Command) => void commands.push(c),
    registerContextMenuItem: (i: ContextMenuItem) => void contextMenu.push(i),
    registerSettingsSection: (s: SettingsSectionDescriptor) => void settingsSections.push(s),
    registerFsProvider: () => {},
    registerDialog: (d: DialogDescriptor) => void dialogs.push(d),
    openDialog: () => {},
    closeDialog: () => {},
    jobs,
    toast: { show: () => {}, error: () => {} },
    events: { listen: () => {} },
    storage: {
      get: async () => ({ ...store }),
      set: async (v: Record<string, unknown>) => {
        store = { ...v };
      },
    },
    workspace: {
      getSelection: () => [],
      getVisibleEntries: () => [],
      navigate: async () => {},
      refreshPanes: async () => {},
      moveFile: async () => ({ ok: true }),
    },
    openSettings: () => {},
  } as unknown as PluginContext;

  return { ctx, commands, contextMenu, settingsSections, dialogs, getStore: () => store };
}

describe("ai-organize plugin: contributions", () => {
  it("registers a command, context item, settings section and dialog", async () => {
    await writeConfigFile("plugin.ai-rename.json", "{}");
    const f = makeFakeCtx();
    await aiOrganizePlugin.activate(f.ctx);

    expect(f.commands.map((c) => c.id)).toContain("plugin.ai-organize.suggest");
    expect(f.dialogs.map((d) => d.id)).toContain("ai-organize.suggest");
    expect(f.settingsSections).toHaveLength(1);
    expect(f.settingsSections[0].rows[0]).toMatchObject({ id: "apiKey", type: "password" });
    expect(f.contextMenu).toHaveLength(1);
  });

  it("context item shows only for a single real file", async () => {
    await writeConfigFile("plugin.ai-rename.json", "{}");
    const f = makeFakeCtx();
    await aiOrganizePlugin.activate(f.ctx);
    const { when } = f.contextMenu[0];

    expect(when([fileEntry("a.txt")])).toBe(true);
    expect(when([fileEntry("dir", "directory")])).toBe(false);
    expect(when([])).toBe(false);
    expect(when([fileEntry("a.txt"), fileEntry("b.txt")])).toBe(false);
    expect(when([{ ...fileEntry("v.txt"), path: "demo://v.txt" }])).toBe(false);
  });
});

describe("ai-organize plugin: API key seeding", () => {
  it("seeds the key from ai-rename's storage once", async () => {
    await writeConfigFile("plugin.ai-rename.json", JSON.stringify({ apiKey: "shared-key" }));
    const f = makeFakeCtx();
    await aiOrganizePlugin.activate(f.ctx);
    expect(f.getStore().apiKey).toBe("shared-key");
  });

  it("does not overwrite a present (even cleared) key", async () => {
    await writeConfigFile("plugin.ai-rename.json", JSON.stringify({ apiKey: "shared-key" }));
    const f = makeFakeCtx({ apiKey: "" });
    await aiOrganizePlugin.activate(f.ctx);
    expect(f.getStore().apiKey).toBe("");
  });
});

describe("gatherCandidates", () => {
  const target = fileEntry("notes.md"); // parent /home/u

  it("collects visible subdirectories and bookmarks, minus the file's parent", () => {
    const visible = [
      fileEntry("Docs", "directory"),
      fileEntry("Pics", "directory"),
      fileEntry("other.txt", "file"),
    ];
    const bookmarks = ["/home/u/Docs", "/mnt/archive", "/home/u"];
    const out = gatherCandidates(target, visible, bookmarks);
    expect(out).toEqual(["/home/u/Docs", "/home/u/Pics", "/mnt/archive"]);
  });

  it("skips virtual paths and caps the list", () => {
    const visible = Array.from({ length: 60 }, (_, i) => fileEntry(`d${i}`, "directory"));
    const bookmarks = ["demo://virtual"];
    const out = gatherCandidates(target, visible, bookmarks);
    expect(out).toHaveLength(MAX_CANDIDATES);
    expect(out.some((p) => p.startsWith("demo://"))).toBe(false);
  });
});
