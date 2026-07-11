/**
 * Upscale plugin — AI image upscaling (fal.ai SeedVR2) (#276).
 *
 * Contributions:
 *   - a settings section (fal.ai API key, password row → plugin storage)
 *   - a context-menu item (single raster image selected → open the dialog)
 *   - a command-palette entry ("Upscale: Upscale Image…")
 *   - a modal dialog (scale factor / output filename)
 *   - completion/error event listeners (→ jobs + toast + pane refresh)
 *
 * The backend command (`start_upscale_job` in src-tauri/src/upscale.rs)
 * uploads the image to fal's CDN, runs the SeedVR2 queue job, and writes the
 * result next to the original; this plugin only wires the frontend surface.
 */

import type { Plugin, PluginContext } from "../api";
import { basename } from "$lib/domain/path";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import type { FileEntry } from "$lib/domain/file";
import UpscaleDialog from "./UpscaleDialog.svelte";

const PLUGIN_ID = "upscale";
const DIALOG_ID = "upscale.dialog";
const API_KEY_STORAGE_KEY = "apiKey";

/** Formats SeedVR2 accepts as input. Narrower than isImageFile on purpose:
 *  gif/bmp/icns/avif thumbnails render fine locally but fal rejects them. */
const UPSCALABLE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function isUpscalableImage(entry: FileEntry): boolean {
  const dot = entry.name.lastIndexOf(".");
  if (dot <= 0) return false;
  return UPSCALABLE_EXTENSIONS.has(entry.name.slice(dot + 1).toLowerCase());
}

/** A single selected upscalable image file, or null. Shared predicate for
 *  menu + command. */
function selectedImage(entries: FileEntry[]): FileEntry | null {
  if (entries.length !== 1) return null;
  const entry = entries[0];
  // Virtual entries are plugin views, not real files (#152).
  if (isVirtualPath(entry.path)) return null;
  return entry.kind === "file" && isUpscalableImage(entry) ? entry : null;
}

/** Read the current API key from plugin storage. */
async function currentApiKey(ctx: PluginContext): Promise<string> {
  const stored = await ctx.storage.get();
  const key = stored[API_KEY_STORAGE_KEY];
  return typeof key === "string" ? key : "";
}

export const upscalePlugin: Plugin = {
  id: PLUGIN_ID,
  name: "Upscale",
  description:
    "AI image upscaling with SeedVR2 on fal.ai — right-click an image to increase its resolution.",
  enabledByDefault: true,

  async activate(ctx) {
    // Open the dialog for a given image, wiring in the current API key and
    // this plugin's capability handles. Read the key at open time (settings
    // and this dialog can't be open simultaneously).
    const openUpscaler = async (sourcePath: string): Promise<void> => {
      const apiKey = await currentApiKey(ctx);
      ctx.openDialog(DIALOG_ID, {
        sourcePath,
        apiKey,
        jobs: ctx.jobs,
        toast: ctx.toast,
        onOpenSettings: () => dialogStore.openSettings(),
      });
    };

    // 1. Settings section — API key (password row → plugin storage).
    ctx.registerSettingsSection({
      id: PLUGIN_ID,
      title: "AI / Upscale",
      rows: [
        {
          id: API_KEY_STORAGE_KEY,
          label: "fal.ai API Key",
          description:
            "Required for SeedVR2 upscaling (right-click images). Falls back to the FAL_KEY environment variable.",
          type: "password",
        },
      ],
    });

    // 2. Context-menu item — single raster image selected.
    ctx.registerContextMenuItem({
      id: "upscale.run",
      label: "Upscale Image",
      icon: "M8 3H3V8M3 3L7 7M8 13H13V8M13 13L9 9",
      when: (entries) => selectedImage(entries) !== null,
      handler: (entries) => {
        const image = selectedImage(entries);
        if (image) void openUpscaler(image.path);
      },
    });

    // 3. Dialog.
    ctx.registerDialog({ id: DIALOG_ID, component: UpscaleDialog });

    // 4. Command-palette entry.
    ctx.registerCommand({
      id: "plugin.upscale.run",
      label: "Upscale: Upscale Image…",
      category: "plugins",
      handler: () => {
        const entries = windowTabsManager.getActiveExplorer()?.getSelectedEntries() ?? [];
        const image = selectedImage(entries);
        if (image) void openUpscaler(image.path);
        else ctx.toast.show("Select a JPG, PNG, or WebP image first", "info");
      },
    });

    // 5. Completion / error events → jobs, toast, pane refresh.
    ctx.events.listen<{ jobId: number; outputPath: string }>(
      "upscale-complete",
      ({ jobId, outputPath }) => {
        ctx.jobs.complete(jobId, outputPath);
        ctx.toast.show(`Upscale complete: ${basename(outputPath)}`, "success");
        for (const exp of windowTabsManager.getAllExplorers()) void exp.refresh();
      },
    );

    ctx.events.listen<{ jobId: number; error: string }>("upscale-error", ({ jobId, error }) => {
      ctx.jobs.fail(jobId, error);
      ctx.toast.error(`Upscale failed: ${error.slice(0, 100)}`);
    });
  },
};
