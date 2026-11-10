/**
 * Registers the built-in `trash://` location (#863). Only this registration is
 * eager; listing, restore, menu actions and view refresh load from
 * `trash-location.ts` with the first Trash listing. Startup-graph services are
 * passed in rather than imported there, which would split them into new chunks.
 */
import { registerFsProvider } from "$lib/plugins/fs-providers";
import type { FileEntry } from "$lib/domain/file";
import { contextMenuItems } from "./context-menu-items.svelte";
import type { DragData } from "./drag.svelte";

const load = () => import("./trash-location");

/** Double-clicking a trashed item explains how to get it back. */
export function explainTrashedOpen(entry: FileEntry): void {
  void load().then((trash) => trash.explainTrashedOpen(entry));
}

/** A drop of Trash entries (a `trash://` drag source) restores them into the
 * target's folder, never moves them by path (#1554). Routing loads lazily. */
export function dropTrashEntries(source: DragData, target: { type: string; path?: string } | null, fallbackDirectory?: string): Promise<void> {
  return load().then((trash) => trash.completeTrashDrop(source, target, fallbackDirectory));
}

/** Register the provider; call once per window before tab restore navigates. */
export function installTrashLocation(): () => void {
  return registerFsProvider("trash", {
    list: async (path) => {
      const trash = await load();
      trash.installTrashActions(contextMenuItems);
      return trash.listTrashLocation(path);
    },
  }, false);
}
