/**
 * The in-app Trash location (#863): listing and restore orchestration. Loaded
 * on first use by the provider `trash-provider.ts` registers, so it stays out
 * of the startup bundle. Panes navigate, sort, select and switch views through
 * the ordinary explorer path; only listing and restore are special.
 */
import { listTrash, restoreTrashItems, deleteTrashItems } from "$lib/api/trash";
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
  /** Clock for issue re-reporting; tests supply their own. */
  now?(): number;
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
    // Offered only when every selected item has a recorded origin.
    when: (entries) => entries.length > 0 && entries.every((entry) => entry.trash?.originalPath),
    handler: (entries) => { void restoreFromTrash(entries); },
  }, 0);
  menu.register({
    id: "trash.delete",
    label: "Permanently Delete…",
    scope: "trash",
    icon: "M3 4H13M6 4V2H10V4M4 4L5 14H11L12 4M7 6V12M9 6V12",
    when: (entries) => entries.length > 0 && entries.every((entry) => entry.trash),
    handler: (entries) => { windowTabsManager.getActiveExplorer()?.startPermanentDelete([...entries]); },
  }, 1);
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

// A refresh repeats the same issue; report it again only after a while, so
// reopening the Trash later still says which sources are missing.
const ISSUE_REPEAT_MS = 60_000;
let reportedIssues: { message: string; at: number } | null = null;

/** Provider listing: the Trash root only; trashed folders open after restore. */
export async function listTrashLocation(path: string, ports: TrashPorts = defaultPorts): Promise<DirectoryListing> {
  if (!isTrashRoot(path)) {
    throw new Error("Items in the Trash cannot be opened. Restore this folder to browse its contents.");
  }
  const result = await ports.list();
  if (!result.ok) throw new Error(`Could not read the Trash: ${result.error}`);
  const issues = trashIssuesMessage(result.data.issues);
  const now = (ports.now ?? Date.now)();
  if (issues && (issues !== reportedIssues?.message || now - reportedIssues.at >= ISSUE_REPEAT_MS)) {
    ports.error(issues);
    reportedIssues = { message: issues, at: now };
  } else if (!issues) {
    reportedIssues = null;
  }
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

/** Translate native opaque IDs back to the pane's stable entry paths. */
export async function deleteFromTrash(entries: readonly FileEntry[]): Promise<ApiResult<FileBatchOutcome>> {
  if (!entries.every(entry => entry.trash)) return { ok: false, error: "Select only items in the Trash." };
  const byId = new Map(entries.map(entry => [entry.trash!.id, entry.path]));
  const result = await deleteTrashItems([...byId.keys()]);
  if (!result.ok) return result;
  const path = (id: string) => byId.get(id) ?? id;
  const failure = (item: { path: string; error: string }) => ({ ...item, path: path(item.path) });
  const outcome = result.data;
  return { ...result, data: {
    ...outcome,
    succeeded: outcome.succeeded.map(path),
    failed: outcome.failed.map(failure),
    ...(outcome.uncertain ? { uncertain: outcome.uncertain.map(failure) } : {}),
    ...(outcome.unstarted ? { unstarted: outcome.unstarted.map(path) } : {}),
    ...(outcome.warnings ? { warnings: outcome.warnings.map(failure) } : {}),
  } };
}
