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
import { suggestFilenames } from "$lib/api/ai-rename";
import {
  buildContentHint,
  canSendContentHint,
  sanitizeChosenName,
  CONTENT_HINT_MAX_CHARS,
} from "$lib/domain/ai-rename";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import {
  renameSuggestionStore,
  type RenameSuggestionProvider,
} from "$lib/state/rename-suggestion.svelte";
import type { FileEntry } from "$lib/domain/file";
import { isVirtualPath } from "$lib/domain/virtual-path";
import AiRenameDialog from "./AiRenameDialog.svelte";

const PLUGIN_ID = "ai-rename";
const DIALOG_ID = "ai-rename.suggest";
const API_KEY_STORAGE_KEY = "apiKey";
const COUNT_STORAGE_KEY = "count";
const INLINE_STORAGE_KEY = "inlineAutocomplete";
const DEFAULT_COUNT = 3;

/** A single selected file (not a directory), or null. Shared by menu + command. */
function selectedFile(entries: FileEntry[]): FileEntry | null {
  if (entries.length !== 1) return null;
  const entry = entries[0];
  // Virtual entries are plugin views, not real files — reading/renaming
  // them would hit the OS backend with a scheme:// path (#152).
  if (isVirtualPath(entry.path)) return null;
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

/** Whether the inline rename autocomplete is enabled (default true). */
async function inlineAutocompleteEnabled(ctx: PluginContext): Promise<boolean> {
  const stored = await ctx.storage.get();
  const raw = stored[INLINE_STORAGE_KEY];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw !== "false";
  return true;
}

// Module-scoped so deactivate() can unregister exactly what activate()
// registered.
let inlineProvider: RenameSuggestionProvider | null = null;

export const aiRenamePlugin: Plugin = {
  id: PLUGIN_ID,
  name: "AI Rename",
  description:
    "AI-suggested filenames — right-click a file and pick a better name, or press Tab in the rename box to accept the inline suggestion. Sends the filename (and, for text files, a short content preview) to Gemini only when you invoke the action.",
  enabledByDefault: true,

  async activate(ctx) {
    // Inline autocomplete provider (#215): queried when a rename box opens —
    // that user action is the moment the (text-only) content hint is read,
    // same privacy path as the explicit picker. Returns null (no suggestion,
    // no network call) without an API key or with the toggle off.
    inlineProvider = async (entry: FileEntry): Promise<string | null> => {
      if (entry.kind !== "file" || isVirtualPath(entry.path)) return null;
      if (!(await inlineAutocompleteEnabled(ctx))) return null;
      const apiKey = await currentApiKey(ctx);
      if (!apiKey) return null;
      const contentHint = await gatherContentHint(entry);
      const result = await suggestFilenames(entry.name, contentHint, 1, apiKey);
      if (!result.ok || result.data.length === 0) return null;
      const name = sanitizeChosenName(result.data[0], entry.name);
      return name === entry.name ? null : name;
    };
    renameSuggestionStore.setProvider(inlineProvider);
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
          description: "How many names to propose.",
          type: "select",
          options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) })),
          default: String(DEFAULT_COUNT),
        },
        {
          id: INLINE_STORAGE_KEY,
          label: "Inline rename autocomplete",
          description:
            "Suggest a name in the rename box (press Tab to accept). Queries the model each time a rename starts.",
          type: "toggle",
          default: true,
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

  deactivate() {
    // The provider isn't a ctx contribution, so it isn't in the disposal
    // ledger — unregister it explicitly.
    if (inlineProvider) {
      renameSuggestionStore.clearProvider(inlineProvider);
      inlineProvider = null;
    }
  },
};
