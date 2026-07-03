/**
 * AI Rename plugin: contribution surface and dispose
 * (src/lib/plugins/ai-rename/index.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub the dialog .svelte import (node-env can't compile Svelte markup); the
// registry only stores it as an opaque component reference.
vi.mock("$lib/plugins/ai-rename/AiRenameDialog.svelte", () => ({ default: {} }));

import { aiRenamePlugin } from "$lib/plugins/ai-rename";
import { createPluginContext } from "$lib/plugins/api";
import type { PluginContext, SettingsSectionDescriptor } from "$lib/plugins/api";
import type { ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import type { Command } from "$lib/state/commands.svelte";
import type { DialogDescriptor } from "$lib/plugins/dialog-registry.svelte";
import { getCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import type { FileEntry } from "$lib/domain/file";

const DIALOG_ID = "ai-rename.suggest";
const COMMAND_ID = "plugin.ai-rename.suggest";

function fileEntry(name: string): FileEntry {
  return { name, path: `/${name}`, kind: "file", size: 1, modified: "2024-01-01T00:00:00.000Z" };
}
const textEntry = fileEntry("notes.txt");
const imageEntry = fileEntry("photo.png");
const dirEntry: FileEntry = { ...fileEntry("folder"), kind: "directory" };

/** Recording fake ctx with in-memory storage. */
function makeFakeCtx() {
  const commands: Command[] = [];
  const contextMenu: ContextMenuItem[] = [];
  const settingsSections: SettingsSectionDescriptor[] = [];
  const dialogs: DialogDescriptor[] = [];
  let store: Record<string, unknown> = {};

  const ctx: PluginContext = {
    registerCommand: (c) => void commands.push(c),
    registerContextMenuItem: (i) => void contextMenu.push(i),
    registerSettingsSection: (s) => void settingsSections.push(s),
    registerFsProvider: () => {},
    registerDialog: (d) => void dialogs.push(d),
    openDialog: () => {},
    closeDialog: () => {},
    jobs: { add: () => {}, complete: () => {}, fail: () => {} },
    toast: { show: () => {}, error: () => {} },
    events: { listen: () => {} },
    storage: { get: async () => ({ ...store }), set: async (v) => void (store = { ...v }) },
  };

  return { ctx, commands, contextMenu, settingsSections, dialogs };
}

describe("ai-rename plugin: contributions", () => {
  it("registers a command, context item, settings section and dialog", async () => {
    const f = makeFakeCtx();
    await aiRenamePlugin.activate(f.ctx);

    expect(f.commands.map((c) => c.id)).toContain(COMMAND_ID);
    expect(f.dialogs.map((d) => d.id)).toContain(DIALOG_ID);
    expect(f.contextMenu).toHaveLength(1);

    // Settings: password key row + a suggestion-count row.
    expect(f.settingsSections).toHaveLength(1);
    const [section] = f.settingsSections;
    expect(section.rows[0]).toMatchObject({ id: "apiKey", type: "password" });
    expect(section.rows.map((r) => r.id)).toContain("count");
  });

  it("context item shows for a single file, not directories or multi-select", async () => {
    const f = makeFakeCtx();
    await aiRenamePlugin.activate(f.ctx);
    const { when } = f.contextMenu[0];

    expect(when([textEntry])).toBe(true);
    expect(when([imageEntry])).toBe(true); // any file, not just images
    expect(when([dirEntry])).toBe(false);
    expect(when([])).toBe(false);
    expect(when([textEntry, imageEntry])).toBe(false);
  });
});

describe("ai-rename plugin: dispose", () => {
  beforeEach(() => dialogRegistry.clear());

  it("removes command, context item and dialog on dispose", async () => {
    const { ctx, dispose } = createPluginContext("ai-rename");
    await aiRenamePlugin.activate(ctx);

    expect(getCommand(COMMAND_ID)).toBeDefined();
    expect(contextMenuItems.itemsFor([textEntry]).some((i) => i.id === DIALOG_ID)).toBe(true);
    dialogRegistry.open(DIALOG_ID, {});
    expect(dialogRegistry.isOpen(DIALOG_ID)).toBe(true);

    dispose();

    expect(getCommand(COMMAND_ID)).toBeUndefined();
    expect(contextMenuItems.itemsFor([textEntry]).some((i) => i.id === DIALOG_ID)).toBe(false);
    expect(dialogRegistry.isOpen(DIALOG_ID)).toBe(false);
  });
});
