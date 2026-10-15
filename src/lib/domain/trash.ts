/**
 * The in-app Trash location (#863). Pure mapping between the native trash
 * inventory and Explorer entries; no framework or IPC dependencies.
 */
import type { DirectoryListing, FileEntry } from "./file";
import type { FileBatchOutcome } from "./file-batch-outcome";
import { TRASH_PATH, parseVirtualPath } from "./virtual-path";

export { TRASH_PATH, isTrashPath } from "./virtual-path";

/** True for the Trash root, in either `trash://` or `trash:///` spelling. */
export function isTrashRoot(path: string): boolean {
  const parsed = parseVirtualPath(path);
  return parsed?.scheme === "trash" && parsed.rest.replace(/^\/+/, "") === "";
}

/** Each trashed item has a unique, stable Explorer path built from its ID. */
export function trashEntryPath(id: string): string {
  return `${TRASH_PATH}${id}`;
}

/** The folder an item was deleted from, for the "Original location" column. */
export function originalFolder(originalPath: string | null): string | null {
  if (!originalPath) return null;
  const trimmed = originalPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  // Keep a root separator: "/a.txt" came from "/", "C:\a.txt" from "C:\".
  return cut === 0 || trimmed[cut - 1] === ":" ? trimmed.slice(0, cut + 1) : trimmed.slice(0, cut);
}

/** One item as `list_trash` reports it. */
export interface TrashWireEntry {
  id: string;
  name: string;
  originalPath: string | null;
  deletedAt: string | null;
  kind: "file" | "directory";
  size: number;
  isSymlink: boolean;
}

/** A trash source (or some of its records) that could not be read. */
export interface TrashIssue {
  source: string;
  error: string;
}

export interface TrashWireListing {
  entries: TrashWireEntry[];
  issues: TrashIssue[];
}

export function toTrashEntry(item: TrashWireEntry): FileEntry {
  return {
    name: item.name,
    path: trashEntryPath(item.id),
    kind: item.kind,
    size: item.size,
    // Dates sort and render through the ordinary "modified" column.
    modified: item.deletedAt ?? "",
    is_symlink: item.isSymlink,
    trash: {
      id: item.id, originalPath: item.originalPath, deletedAt: item.deletedAt,
      originalFolder: originalFolder(item.originalPath),
    },
  };
}

export function toTrashListing(wire: TrashWireListing): DirectoryListing {
  return { path: TRASH_PATH, entries: wire.entries.map(toTrashEntry) };
}

/** One message summarizing unreadable sources, or null when all were read. */
export function trashIssuesMessage(issues: readonly TrashIssue[]): string | null {
  if (!issues.length) return null;
  const details = issues.map(({ source, error }) => `${source}: ${error}`).join("; ");
  return issues.length === 1
    ? `Some trash items could not be shown. ${details}`
    : `${issues.length} trash locations could not be fully read. ${details}`;
}

/** User-facing summary of a restore: what came back and why anything did not. */
export function restoreSummary(
  outcome: FileBatchOutcome,
  requested: readonly FileEntry[],
): { restored: string[]; message: string; failed: boolean } {
  const label = (key: string) => {
    const entry = requested.find((candidate) => candidate.trash?.originalPath === key || candidate.trash?.id === key);
    return entry?.name ?? key;
  };
  const problems = [
    ...outcome.failed.map(({ path, error }) => `${label(path)}: ${error}`),
    ...(outcome.uncertain ?? []).map(({ path, error }) => `${label(path)}: the outcome is uncertain; check ${path} before retrying (${error})`),
    ...(outcome.warnings ?? []).map(({ path, error }) => `${label(path)}: ${error}`),
  ];
  if (outcome.workerError !== undefined) problems.push(`The restore did not finish cleanly: ${outcome.workerError}`);
  const restored = outcome.succeeded;
  const done = restored.length === 1
    ? `Restored ${label(restored[0])} to ${restored[0]}`
    : restored.length > 1 ? `Restored ${restored.length} items` : "";
  if (!problems.length) return { restored, message: done, failed: false };
  const prefix = restored.length ? `${done}. ` : "";
  const noun = problems.length === 1 ? "item" : "items";
  return {
    restored,
    message: `${prefix}Could not restore ${problems.length} ${noun}: ${problems.join("; ")}`,
    failed: true,
  };
}
