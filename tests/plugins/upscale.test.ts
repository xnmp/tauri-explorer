/**
 * Upscale plugin: contribution surface, selection predicate, and dispose
 * (src/lib/plugins/upscale/index.ts) (#276).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub the dialog component so the node-env test doesn't compile Svelte markup.
vi.mock("$lib/plugins/upscale/UpscaleDialog.svelte", () => ({ default: {} }));

import { upscalePlugin } from "$lib/plugins/upscale";
import { createPluginContext } from "$lib/plugins/api";
import type { PluginContext, SettingsSectionDescriptor } from "$lib/plugins/api";
import type { ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import type { Command } from "$lib/state/commands.svelte";
import type { DialogDescriptor } from "$lib/plugins/dialog-registry.svelte";
import { getCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import type { FileEntry } from "$lib/domain/file";

const DIALOG_ID = "upscale.dialog";
const COMMAND_ID = "plugin.upscale.run";

function fileEntry(name: string): FileEntry {
  return { name, path: `/${name}`, kind: "file", size: 1, modified: "2024-01-01T00:00:00.000Z" };
}

const jpgEntry = fileEntry("photo.jpg");
const pngEntry = fileEntry("shot.PNG");
const webpEntry = fileEntry("art.webp");
const gifEntry = fileEntry("anim.gif");
const svgEntry = fileEntry("icon.svg");
const textEntry = fileEntry("notes.txt");
const dirEntry: FileEntry = { ...fileEntry("folder"), kind: "directory" };

function makeFakeCtx() {
  const commands: Command[] = [];
  const contextMenu: ContextMenuItem[] = [];
  const settingsSections: SettingsSectionDescriptor[] = [];
  const dialogs: DialogDescriptor[] = [];
  const events: string[] = [];

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
    events: { listen: (name) => void events.push(name) },
    storage: {
      get: async () => ({}),
      set: async () => {},
    },
  };

  return { ctx, commands, contextMenu, settingsSections, dialogs, events };
}

describe("upscale plugin: contributions", () => {
  it("registers a command, context item, settings section, dialog and two event listeners", async () => {
    const f = makeFakeCtx();
    await upscalePlugin.activate(f.ctx);

    expect(f.commands.map((c) => c.id)).toContain(COMMAND_ID);
    expect(f.dialogs.map((d) => d.id)).toContain(DIALOG_ID);
    expect(f.events).toEqual(["upscale-complete", "upscale-error"]);

    // Settings section: a single password row bound to the "apiKey" key.
    expect(f.settingsSections).toHaveLength(1);
    expect(f.settingsSections[0].rows[0]).toMatchObject({ id: "apiKey", type: "password" });

    expect(f.contextMenu).toHaveLength(1);
  });

  it("context item shows only for a single raster image fal accepts", async () => {
    const f = makeFakeCtx();
    await upscalePlugin.activate(f.ctx);
    const { when } = f.contextMenu[0];

    expect(when([jpgEntry])).toBe(true);
    expect(when([pngEntry])).toBe(true); // extension check is case-insensitive
    expect(when([webpEntry])).toBe(true);

    // Formats SeedVR2 rejects don't get the menu entry even though the app
    // treats them as images elsewhere (thumbnails).
    expect(when([gifEntry])).toBe(false);
    expect(when([svgEntry])).toBe(false);

    expect(when([textEntry])).toBe(false);
    expect(when([dirEntry])).toBe(false);
    expect(when([])).toBe(false);
    expect(when([jpgEntry, pngEntry])).toBe(false); // multi-select
    // Virtual entries are plugin views, not real files (#152).
    expect(when([{ ...jpgEntry, path: "demo://photo.jpg" }])).toBe(false);
  });
});

describe("upscale plugin: dispose", () => {
  beforeEach(() => dialogRegistry.clear());

  it("removes command, context item and dialog on dispose", async () => {
    const { ctx, dispose } = createPluginContext("upscale");
    await upscalePlugin.activate(ctx);

    expect(getCommand(COMMAND_ID)).toBeDefined();
    expect(contextMenuItems.itemsFor([jpgEntry]).some((i) => i.id === "upscale.run")).toBe(true);
    dialogRegistry.open(DIALOG_ID, {});
    expect(dialogRegistry.isOpen(DIALOG_ID)).toBe(true);

    dispose();

    expect(getCommand(COMMAND_ID)).toBeUndefined();
    expect(contextMenuItems.itemsFor([jpgEntry]).some((i) => i.id === "upscale.run")).toBe(false);
    expect(dialogRegistry.isOpen(DIALOG_ID)).toBe(false);
  });
});
