/**
 * Nano Banana plugin: contribution surface, dispose, and legacy-key migration
 * (src/lib/plugins/nano-banana/index.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// The plugin statically imports its dialog .svelte component; stub it so the
// node-env test doesn't try to compile Svelte markup/CSS (it's only stored as
// an opaque component reference by the dialog registry).
vi.mock("$lib/plugins/nano-banana/NanoBananaDialog.svelte", () => ({ default: {} }));

import { nanoBananaPlugin } from "$lib/plugins/nano-banana";
import { createPluginContext } from "$lib/plugins/api";
import type { PluginContext, SettingsSectionDescriptor } from "$lib/plugins/api";
import type { ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import type { Command } from "$lib/state/commands.svelte";
import type { DialogDescriptor } from "$lib/plugins/dialog-registry.svelte";
import { getCommand } from "$lib/state/commands.svelte";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { writeConfigFile, readConfigFile } from "$lib/api/files";
import type { FileEntry } from "$lib/domain/file";

const DIALOG_ID = "nano-banana.edit";
const COMMAND_ID = "plugin.nano-banana.edit";

function fileEntry(name: string): FileEntry {
  return { name, path: `/${name}`, kind: "file", size: 1, modified: "2024-01-01T00:00:00.000Z" };
}

const imageEntry = fileEntry("photo.png");
const textEntry = fileEntry("notes.txt");
const dirEntry: FileEntry = { ...fileEntry("folder"), kind: "directory" };

/** Recording fake ctx with in-memory storage — full control over migration inputs. */
function makeFakeCtx(seedStorage: Record<string, unknown> = {}) {
  let store: Record<string, unknown> = { ...seedStorage };
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
      get: async () => ({ ...store }),
      set: async (v) => {
        store = { ...v };
      },
    },
  };

  return { ctx, commands, contextMenu, settingsSections, dialogs, events, getStore: () => store };
}

describe("nano-banana plugin: contributions", () => {
  it("registers a command, context item, settings section, dialog and two event listeners", async () => {
    const f = makeFakeCtx();
    await nanoBananaPlugin.activate(f.ctx);

    expect(f.commands.map((c) => c.id)).toContain(COMMAND_ID);
    expect(f.dialogs.map((d) => d.id)).toContain(DIALOG_ID);
    expect(f.events).toEqual(["nano-banana-complete", "nano-banana-error"]);

    // Settings section: a single password row bound to the "apiKey" key.
    expect(f.settingsSections).toHaveLength(1);
    const [section] = f.settingsSections;
    expect(section.rows).toHaveLength(1);
    expect(section.rows[0]).toMatchObject({ id: "apiKey", type: "password" });

    // Context item present.
    expect(f.contextMenu).toHaveLength(1);
  });

  it("context item shows only for a single image selection", async () => {
    const f = makeFakeCtx();
    await nanoBananaPlugin.activate(f.ctx);
    const { when } = f.contextMenu[0];

    expect(when([imageEntry])).toBe(true);
    expect(when([textEntry])).toBe(false);
    expect(when([dirEntry])).toBe(false);
    expect(when([])).toBe(false);
    expect(when([imageEntry, imageEntry])).toBe(false); // multi-select
    // Virtual entries are plugin views, not real files (#152).
    expect(when([{ ...imageEntry, path: "demo://photo.png" }])).toBe(false);
  });
});

describe("nano-banana plugin: legacy API key migration", () => {
  it("copies a legacy geminiApiKey from settings.json into plugin storage", async () => {
    await writeConfigFile("settings.json", JSON.stringify({ geminiApiKey: "legacy-key-123" }));
    const f = makeFakeCtx(); // empty plugin storage

    await nanoBananaPlugin.activate(f.ctx);

    expect(f.getStore().apiKey).toBe("legacy-key-123");
  });

  it("does not overwrite an existing plugin key", async () => {
    await writeConfigFile("settings.json", JSON.stringify({ geminiApiKey: "legacy-key-123" }));
    const f = makeFakeCtx({ apiKey: "already-set" });

    await nanoBananaPlugin.activate(f.ctx);

    expect(f.getStore().apiKey).toBe("already-set");
  });

  it("leaves storage untouched when there is no legacy key", async () => {
    await writeConfigFile("settings.json", JSON.stringify({ theme: "dark" }));
    const f = makeFakeCtx();

    await nanoBananaPlugin.activate(f.ctx);

    expect(f.getStore().apiKey).toBeUndefined();
  });

  it("does not resurrect the legacy key after the user cleared theirs (#153)", async () => {
    await writeConfigFile("settings.json", JSON.stringify({ geminiApiKey: "legacy-key-123" }));
    // User explicitly cleared the key in Settings: stored as "".
    const f = makeFakeCtx({ apiKey: "" });

    await nanoBananaPlugin.activate(f.ctx);

    expect(f.getStore().apiKey).toBe("");
  });

  it("removes the migrated secret from settings.json (#153)", async () => {
    await writeConfigFile(
      "settings.json",
      JSON.stringify({ theme: "dark", geminiApiKey: "legacy-key-123" }),
    );
    const f = makeFakeCtx();

    await nanoBananaPlugin.activate(f.ctx);
    // The queued settings.json rewrite is async; give it a tick to flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(f.getStore().apiKey).toBe("legacy-key-123");
    const after = await readConfigFile("settings.json");
    expect(after.ok).toBe(true);
    const parsed = JSON.parse((after as { ok: true; data: string }).data);
    expect(parsed.geminiApiKey).toBeUndefined();
    expect(parsed.theme).toBe("dark"); // other settings untouched
  });
});

describe("nano-banana plugin: dispose", () => {
  beforeEach(() => dialogRegistry.clear());

  it("removes command, context item and dialog on dispose", async () => {
    await writeConfigFile("settings.json", "{}");
    const { ctx, dispose } = createPluginContext("nano-banana");
    await nanoBananaPlugin.activate(ctx);

    // Contributions landed in the real registries.
    expect(getCommand(COMMAND_ID)).toBeDefined();
    expect(contextMenuItems.itemsFor([imageEntry]).some((i) => i.id === DIALOG_ID)).toBe(true);
    dialogRegistry.open(DIALOG_ID, {});
    expect(dialogRegistry.isOpen(DIALOG_ID)).toBe(true);

    dispose();

    expect(getCommand(COMMAND_ID)).toBeUndefined();
    expect(contextMenuItems.itemsFor([imageEntry]).some((i) => i.id === DIALOG_ID)).toBe(false);
    // Dialog closed on dispose and no longer openable.
    expect(dialogRegistry.isOpen(DIALOG_ID)).toBe(false);
    dialogRegistry.open(DIALOG_ID, {});
    expect(dialogRegistry.isOpen(DIALOG_ID)).toBe(false);
  });
});
