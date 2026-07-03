/**
 * Nano Banana plugin — AI image editing (Gemini).
 *
 * The validation case for the plugin API: an existing shipped feature expressed
 * entirely through plugin contributions, with zero nano-banana-specific code
 * left in core components. Ships ENABLED by default (relocated feature, not a
 * new opt-in).
 *
 * Contributions:
 *   - a settings section (Gemini API key, password row → plugin storage)
 *   - a context-menu item (single image selected → open the edit dialog)
 *   - a command-palette entry ("Nano Banana: Edit Image…")
 *   - a modal dialog (prompt / model / output filename)
 *   - completion/error event listeners (→ jobs + toast + pane refresh)
 *
 * The backend command (`start_nano_banana_job`) and its IPC wrapper
 * (`startNanoBananaJob` in api/files.ts) stay compiled-in per the plugin model;
 * this plugin only wires the frontend surface.
 */

import type { Plugin, PluginContext } from "../api";
import { isImageFile } from "$lib/domain/file-types";
import { basename } from "$lib/domain/path";
import { readConfigFile } from "$lib/api/files";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import type { FileEntry } from "$lib/domain/file";
import NanoBananaDialog from "./NanoBananaDialog.svelte";

const PLUGIN_ID = "nano-banana";
const DIALOG_ID = "nano-banana.edit";
const API_KEY_STORAGE_KEY = "apiKey";

/** A single selected image file, or null. Shared predicate for menu + command. */
function selectedImage(entries: FileEntry[]): FileEntry | null {
  if (entries.length !== 1) return null;
  const entry = entries[0];
  return entry.kind === "file" && isImageFile(entry) ? entry : null;
}

/**
 * One-time migration: copy a legacy core `geminiApiKey` (persisted in the main
 * settings.json before this feature became a plugin) into plugin storage, so
 * existing users keep their key. Runs only when plugin storage has no key yet.
 */
async function migrateLegacyApiKey(ctx: PluginContext): Promise<void> {
  const stored = await ctx.storage.get();
  if (stored[API_KEY_STORAGE_KEY]) return; // already migrated / set

  const result = await readConfigFile("settings.json");
  if (!result.ok || !result.data) return;
  try {
    const parsed = JSON.parse(result.data) as Record<string, unknown>;
    const legacy = parsed.geminiApiKey;
    if (typeof legacy === "string" && legacy.length > 0) {
      await ctx.storage.set({ ...stored, [API_KEY_STORAGE_KEY]: legacy });
    }
  } catch {
    // Corrupt settings file — nothing to migrate.
  }
}

/** Read the current API key from plugin storage. */
async function currentApiKey(ctx: PluginContext): Promise<string> {
  const stored = await ctx.storage.get();
  const key = stored[API_KEY_STORAGE_KEY];
  return typeof key === "string" ? key : "";
}

export const nanoBananaPlugin: Plugin = {
  id: PLUGIN_ID,
  name: "Nano Banana",
  description: "AI image editing with Gemini — right-click an image to edit it with a text prompt.",
  enabledByDefault: true,

  async activate(ctx) {
    // Open the edit dialog for a given image, wiring in the current API key and
    // this plugin's capability handles. Read the key at open time (settings and
    // this dialog can't be open simultaneously, so no live reactivity needed).
    const openEditor = async (sourcePath: string): Promise<void> => {
      const apiKey = await currentApiKey(ctx);
      ctx.openDialog(DIALOG_ID, {
        sourcePath,
        apiKey,
        jobs: ctx.jobs,
        toast: ctx.toast,
        onOpenSettings: () => dialogStore.openSettings(),
      });
    };

    // 1. Migrate a pre-plugin API key before seeding the settings section.
    await migrateLegacyApiKey(ctx);

    // 2. Settings section — API key (password row → plugin storage).
    ctx.registerSettingsSection({
      id: "nano-banana",
      title: "AI / Nano Banana",
      rows: [
        {
          id: API_KEY_STORAGE_KEY,
          label: "Gemini API Key",
          description: "Required for Nano Banana image editing (right-click images).",
          type: "password",
        },
      ],
    });

    // 3. Context-menu item — single image selected.
    ctx.registerContextMenuItem({
      id: "nano-banana.edit",
      label: "Edit with Nano Banana",
      icon: "M12 2L14 4L5 13H3V11L12 2Z",
      when: (entries) => selectedImage(entries) !== null,
      handler: (entries) => {
        const image = selectedImage(entries);
        if (image) void openEditor(image.path);
      },
    });

    // 4. Dialog.
    ctx.registerDialog({ id: DIALOG_ID, component: NanoBananaDialog });

    // 5. Command-palette entry.
    ctx.registerCommand({
      id: "plugin.nano-banana.edit",
      label: "Nano Banana: Edit Image…",
      category: "plugins",
      handler: () => {
        const entries = windowTabsManager.getActiveExplorer()?.getSelectedEntries() ?? [];
        const image = selectedImage(entries);
        if (image) void openEditor(image.path);
        else ctx.toast.show("Select an image first", "info");
      },
    });

    // 6. Completion / error events → jobs, toast, pane refresh.
    ctx.events.listen<{ jobId: number; outputPath: string }>("nano-banana-complete", ({ jobId, outputPath }) => {
      ctx.jobs.complete(jobId, outputPath);
      ctx.toast.show(`Nano Banana complete: ${basename(outputPath)}`, "success");
      for (const exp of windowTabsManager.getAllExplorers()) void exp.refresh();
    });

    ctx.events.listen<{ jobId: number; error: string }>("nano-banana-error", ({ jobId, error }) => {
      ctx.jobs.fail(jobId, error);
      ctx.toast.error(`Nano Banana failed: ${error.slice(0, 100)}`);
    });
  },
};
