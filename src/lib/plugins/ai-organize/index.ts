/**
 * AI Organize plugin — suggest where a file belongs (#158).
 *
 * IDE-style "move this file to…" suggestions: a context-menu action on a
 * single file gathers candidate destination folders (subdirectories of the
 * current directory plus bookmarked folders), asks the model to rank the best
 * fits, and shows them in a picker. Accepting one moves the file through the
 * normal transfer flow (conflict dialog, undo, toast). Modelled on ai-rename.
 *
 * PRIVACY: identical policy to ai-rename — file content is read and sent ONLY
 * inside the explicit user action, never from `when` predicates or selection.
 *
 * Contributions:
 *   - a settings section (Gemini API key, seeded once from ai-rename's key)
 *   - a context-menu item (single real file selected)
 *   - a command-palette entry ("AI: Suggest Destination…")
 *   - a modal dialog (the destination picker)
 */

import type { Plugin, PluginContext } from "../api";
import { readTextFile, readConfigFile } from "$lib/api/files";
import { buildContentHint, canSendContentHint, CONTENT_HINT_MAX_CHARS } from "$lib/domain/ai-rename";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { parentDir, directoryKey } from "$lib/domain/path";
import { isVirtualPath } from "$lib/domain/virtual-path";
import type { FileEntry } from "$lib/domain/file";
import AiOrganizeDialog from "./AiOrganizeDialog.svelte";

const PLUGIN_ID = "ai-organize";
const DIALOG_ID = "ai-organize.suggest";
const API_KEY_STORAGE_KEY = "apiKey";
const SUGGESTION_COUNT = 3;
/** Cap the candidate list so prompts stay small and ranking stays sharp. */
export const MAX_CANDIDATES = 40;

/** A single selected real file (not a directory, not virtual), or null. */
function selectedFile(entries: FileEntry[]): FileEntry | null {
  if (entries.length !== 1) return null;
  const entry = entries[0];
  if (isVirtualPath(entry.path)) return null;
  return entry.kind === "file" ? entry : null;
}

/**
 * Candidate destinations for `entry`: subdirectories visible in the active
 * pane plus bookmarked folders — minus the file's own parent (a move there is
 * a no-op) and any virtual paths. Deduped by directory key, capped.
 */
export function gatherCandidates(
  entry: FileEntry,
  visibleEntries: readonly FileEntry[],
  bookmarkPaths: readonly string[],
): string[] {
  const parent = directoryKey(parentDir(entry.path));
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (path: string) => {
    if (isVirtualPath(path)) return;
    const key = directoryKey(path);
    if (key === parent || seen.has(key)) return;
    seen.add(key);
    out.push(path);
  };

  for (const e of visibleEntries) {
    if (e.kind === "directory") push(e.path);
  }
  for (const p of bookmarkPaths) {
    push(p);
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** Read the API key from plugin storage. */
async function currentApiKey(ctx: PluginContext): Promise<string> {
  const stored = await ctx.storage.get();
  const key = stored[API_KEY_STORAGE_KEY];
  return typeof key === "string" ? key : "";
}

/**
 * One-time seed: copy the ai-rename plugin's stored Gemini key so users who
 * configured it there don't have to paste it twice. Presence-guarded (an
 * empty string means the user cleared it on purpose — see #153).
 */
async function seedApiKeyFromAiRename(ctx: PluginContext): Promise<void> {
  const stored = await ctx.storage.get();
  if (API_KEY_STORAGE_KEY in stored) return;

  const result = await readConfigFile("plugin.ai-rename.json");
  if (!result.ok || !result.data) return;
  try {
    const parsed = JSON.parse(result.data) as Record<string, unknown>;
    const key = parsed.apiKey;
    if (typeof key === "string" && key.length > 0) {
      await ctx.storage.set({ ...stored, [API_KEY_STORAGE_KEY]: key });
    }
  } catch {
    // Corrupt sibling config — nothing to seed.
  }
}

/** Content hint, gathered only inside the explicit user action. */
async function gatherContentHint(entry: FileEntry): Promise<string | undefined> {
  if (!canSendContentHint(entry)) return undefined;
  const result = await readTextFile(entry.path, CONTENT_HINT_MAX_CHARS);
  if (!result.ok) return undefined;
  return buildContentHint(entry, result.data);
}

export const aiOrganizePlugin: Plugin = {
  id: PLUGIN_ID,
  name: "AI Organize",
  description:
    "AI-suggested destinations — right-click a file and pick where it belongs. Sends the filename, candidate folder paths (and, for text files, a short content preview) to Gemini only when you invoke the action.",
  enabledByDefault: true,

  async activate(ctx) {
    await seedApiKeyFromAiRename(ctx);

    const openPicker = async (entry: FileEntry): Promise<void> => {
      const candidates = gatherCandidates(
        entry,
        ctx.workspace.getVisibleEntries(),
        bookmarksStore.list.map((b) => b.path),
      );
      const apiKey = await currentApiKey(ctx);
      const contentHint = await gatherContentHint(entry);
      ctx.openDialog(DIALOG_ID, {
        filePath: entry.path,
        fileName: entry.name,
        contentHint,
        candidates,
        count: SUGGESTION_COUNT,
        apiKey,
        toast: ctx.toast,
        onOpenSettings: () => ctx.openSettings(),
        moveFile: (src: string, destDir: string) => ctx.workspace.moveFile(src, destDir),
      });
    };

    // 1. Settings section — API key.
    ctx.registerSettingsSection({
      id: "ai-organize",
      title: "AI / Destination Suggestions",
      rows: [
        {
          id: API_KEY_STORAGE_KEY,
          label: "Gemini API Key",
          description:
            "Required for AI destination suggestions (right-click a file → Suggest destination).",
          type: "password",
        },
      ],
    });

    // 2. Context-menu item — single real file selected.
    ctx.registerContextMenuItem({
      id: DIALOG_ID,
      label: "Suggest destination…",
      group: "ai",
      icon: "M3 6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z",
      when: (entries) => selectedFile(entries) !== null,
      handler: (entries) => {
        const file = selectedFile(entries);
        if (file) void openPicker(file);
      },
    });

    // 3. Dialog.
    ctx.registerDialog({ id: DIALOG_ID, component: AiOrganizeDialog });

    // 4. Command-palette entry.
    ctx.registerCommand({
      id: "plugin.ai-organize.suggest",
      label: "AI: Suggest Destination…",
      category: "file",
      handler: () => {
        const file = selectedFile(ctx.workspace.getSelection());
        if (file) void openPicker(file);
      },
      when: () => selectedFile(ctx.workspace.getSelection()) !== null,
    });
  },
};
