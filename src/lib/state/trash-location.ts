/**
 * The in-app Trash location (#863): listing and restore orchestration. Loaded
 * on first use by the provider `trash-provider.ts` registers, so it stays out
 * of the startup bundle. Panes navigate, sort, select and switch views through
 * the ordinary explorer path; only listing and restore are special.
 */
import { listTrash, restoreTrashItems } from "$lib/api/trash";
import type { ApiResult } from "$lib/api/common";
import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { affectedBatchPaths, type FileBatchOutcome } from "$lib/domain/file-batch-outcome";
import { parentDir } from "$lib/domain/path";
import {
  TRASH_PATH, isTrashRoot, restoreSummary, toTrashListing, trashIssuesMessage,
  type TrashWireListing,
} from "$lib/domain/trash";
import { openRecycleBin } from "$lib/api/open";
import type { contextMenuItems } from "./context-menu-items.svelte";
import { broadcastFileChange, subscribeToLocalFileChanges } from "./file-events";
import { openRecycleBinWithFeedback } from "./recycle-bin";
import { toastStore } from "./toast.svelte";
import { windowTabsManager } from "./window-tabs.svelte";

export interface TrashPorts {
  list(): Promise<ApiResult<TrashWireListing>>;
  restore(ids: string[]): Promise<ApiResult<FileBatchOutcome>>;
  success(message: string): void;
  error(message: string): void;
  /** Refresh open Trash views and the given real directories. */
  publish(directories: string[]): void;
}

/** Refresh every Trash view (it has no watcher) and other affected panes.
 * Other windows refresh through the file-change broadcast; this window's
 * Trash views refresh through the local subscription `installTrashActions`
 * holds. */
export function publishTrashChanged(directories: readonly string[] = []): void {
  broadcastFileChange([TRASH_PATH, ...directories]);
}

function refreshLocalTrashViews(directories: readonly string[]): void {
  if (!directories.includes(TRASH_PATH)) return;
  for (const explorer of windowTabsManager.getAllExplorers()) explorer.directoryChanged({ path: TRASH_PATH });
}

let actionsInstalled = false;

/** Trash menu actions and local refresh, installed with the first listing:
 * no Trash view can exist in this window before then. */
export function installTrashActions(menu: typeof contextMenuItems): void {
  if (actionsInstalled) return;
  actionsInstalled = true;
  subscribeToLocalFileChanges(refreshLocalTrashViews);
  menu.register({
    id: "trash.restore",
    label: "Restore",
    scope: "trash",
    icon: "M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5",
    when: (entries) => entries.length > 0 && entries.every((entry) => entry.trash),
    handler: (entries) => { void restoreFromTrash(entries); },
  }, 0);
  // The external launcher stays reachable, e.g. for Finder's Put Back on macOS.
  menu.register({
    id: "trash.open-system",
    label: "Open in System File Manager",
    scope: "trash",
    icon: "M9 3H13V7M13 3L7.5 8.5M11 9.5V12.5C11 13 10.5 13.5 10 13.5H3.5C3 13.5 2.5 13 2.5 12.5V6C2.5 5.5 3 5 3.5 5H6.5",
    when: (entries) => entries.length === 0,
    handler: () => openRecycleBinWithFeedback(openRecycleBin, toastStore.error),
  }, 1);
}

const defaultPorts: TrashPorts = {
  list: listTrash,
  restore: restoreTrashItems,
  success: (message) => toastStore.success(message),
  error: (message) => toastStore.error(message),
  publish: (directories) => publishTrashChanged(directories),
};

// Issues are reported once per distinct message, not on every refresh.
let reportedIssues: string | null = null;

/** Provider listing: the Trash root only; trashed folders open after restore. */
export async function listTrashLocation(path: string, ports: TrashPorts = defaultPorts): Promise<DirectoryListing> {
  if (!isTrashRoot(path)) {
    throw new Error("Items in the Trash cannot be opened. Restore this folder to browse its contents.");
  }
  const result = await ports.list();
  if (!result.ok) throw new Error(`Could not read the Trash: ${result.error}`);
  const issues = trashIssuesMessage(result.data.issues);
  if (issues && issues !== reportedIssues) ports.error(issues);
  reportedIssues = issues;
  return toTrashListing(result.data);
}

/** Restore trashed entries to their recorded locations and report each outcome. */
export async function restoreFromTrash(
  entries: readonly FileEntry[],
  ports: TrashPorts = defaultPorts,
): Promise<{ restored: string[]; message: string; failed: boolean } | null> {
  const items = entries.filter((entry) => entry.trash);
  if (!items.length) return null;
  const result = await ports.restore(items.map((entry) => entry.trash!.id));
  if (!result.ok) {
    const message = `Could not restore from the Trash: ${result.error}`;
    ports.error(message);
    return { restored: [], message, failed: true };
  }
  if (result.warning) ports.error(result.warning);
  const summary = restoreSummary(result.data, items);
  ports.publish([...new Set(affectedBatchPaths(result.data).map(parentDir))]);
  if (summary.failed) ports.error(summary.message);
  else ports.success(summary.message);
  return summary;
}

/** Double-clicking a trashed item explains how to get it back. */
export function explainTrashedOpen(entry: FileEntry): void {
  toastStore.show(`Restore ${entry.name} to open it. Right-click it and choose Restore.`, "info");
}
