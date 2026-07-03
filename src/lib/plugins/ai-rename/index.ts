/**
 * AI Rename plugin — suggest better filenames (#145).
 *
 * A context-menu action ("Suggest rename…") that sends the filename plus, for
 * text files, a lightweight content head to the configured model, shows 2-3
 * suggested names in a picker, and applies the chosen one via the normal rename
 * flow. Modelled on the nano-banana plugin's structure.
 *
 * PRIVACY: file content is read and sent ONLY inside `gatherRequest`, which runs
 * exclusively from the explicit user action (menu click / command). Selection
 * and the `when` predicate never touch file content — see the comment there.
 *
 * Contributions:
 *   - a settings section (Gemini API key + suggestion count)
 *   - a context-menu item (single non-directory file selected)
 *   - a command-palette entry ("AI: Suggest Rename…")
 *   - a modal dialog (the suggestion picker)
 *
 * The backend command (`ai_suggest_filenames`) and its IPC wrapper
 * (`suggestFilenames`) stay compiled-in per the plugin model.
 */

import type { Plugin, PluginContext } from "../api";
import { readTextFile } from "$lib/api/files";
import { buildContentHint, canSendContentHint, CONTENT_HINT_MAX_CHARS } from "$lib/domain/ai-rename";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import type { FileEntry } from "$lib/domain/file";
import AiRenameDialog from "./AiRenameDialog.svelte";

const PLUGIN_ID = "ai-rename";
const DIALOG_ID = "ai-rename.suggest";
const API_KEY_STORAGE_KEY = "apiKey";
const COUNT_STORAGE_KEY = "count";
const DEFAULT_COUNT = 3;

/** A single selected file (not a directory), or null. Shared by menu + command. */
function selectedFile(entries: FileEntry[]): FileEntry | null {
  if (entries.length !== 1) return null;
  const entry = entries[0];
  return entry.kind === "file" ? entry : null;
}

/** Read the API key from plugin storage. */
async function currentApiKey(ctx: PluginContext): Promise<string> {
  const stored = await ctx.storage.get();
  const key = stored[API_KEY_STORAGE_KEY];
  return typeof key === "string" ? key : "";
}

/** Read the configured suggestion count from plugin storage (default 3). */
async function currentCount(ctx: PluginContext): Promise<number> {
  const stored = await ctx.storage.get();
  const raw = stored[COUNT_STORAGE_KEY];
  const n = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : DEFAULT_COUNT;
}

/**
 * Gather the suggestion-request inputs for a file. THIS is the only place file
 * content is ever read — and it only runs from an explicit user action, never
 * on selection/hover. For text-like files it reads a truncated head; for
 * everything else no content leaves the machine (hint stays undefined).
 */
async function gatherContentHint(entry: FileEntry): Promise<string | undefined> {
  if (!canSendContentHint(entry)) return undefined;
  const result = await readTextFile(entry.path, CONTENT_HINT_MAX_CHARS);
  if (!result.ok) return undefined;
  return buildContentHint(entry, result.data);
}

export const aiRenamePlugin: Plugin = {
  id: PLUGIN_ID,
  name: "AI Rename",
  description:
    "AI-suggested filenames — right-click a file and pick a better name. Sends the filename (and, for text files, a short content preview) to Gemini only when you invoke the action.",
  enabledByDefault: true,

  async activate(ctx) {
    // Open the picker for a given file: read the key/count/content hint (the
    // content read is the explicit-action moment), then hand off to the dialog.
    const openPicker = async (entry: FileEntry): Promise<void> => {
      const apiKey = await currentApiKey(ctx);
      const count = await currentCount(ctx);
      const contentHint = await gatherContentHint(entry);
      ctx.openDialog(DIALOG_ID, {
        originalPath: entry.path,
        originalName: entry.name,
        contentHint,
        count,
        apiKey,
        toast: ctx.toast,
        onOpenSettings: () => dialogStore.openSettings(),
        refresh: () => windowTabsManager.refreshAllPanes(),
      });
    };

    // 1. Settings section — API key + suggestion count.
    ctx.registerSettingsSection({
      id: "ai-rename",
      title: "AI / Rename Suggestions",
      rows: [
        {
          id: API_KEY_STORAGE_KEY,
          label: "Gemini API Key",
          description: "Required for AI rename suggestions (right-click a file → Suggest rename).",
          type: "password",
        },
        {
          id: COUNT_STORAGE_KEY,
          label: "Number of suggestions",
          description: "How many names to propose (1-5).",
          type: "text",
          default: String(DEFAULT_COUNT),
        },
      ],
    });

    // 2. Context-menu item — single file selected (any type; directories out).
    //    `when` inspects only entry metadata, never file content.
    ctx.registerContextMenuItem({
      id: "ai-rename.suggest",
      label: "Suggest rename…",
      icon: "M12 2L14 4L5 13H3V11L12 2Z",
      when: (entries) => selectedFile(entries) !== null,
      handler: (entries) => {
        const file = selectedFile(entries);
        if (file) void openPicker(file);
      },
    });

    // 3. Dialog.
    ctx.registerDialog({ id: DIALOG_ID, component: AiRenameDialog });

    // 4. Command-palette entry.
    ctx.registerCommand({
      id: "plugin.ai-rename.suggest",
      label: "AI: Suggest Rename…",
      category: "plugins",
      handler: () => {
        const entries = windowTabsManager.getActiveExplorer()?.getSelectedEntries() ?? [];
        const file = selectedFile(entries);
        if (file) void openPicker(file);
        else ctx.toast.show("Select a single file first", "info");
      },
    });
  },
};
