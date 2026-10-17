/** Flat Details geometry and command admission, available before the first peek. */
import type { FileEntry, ViewMode } from "./file";
import type { PeekMeta, PeekTree, PeekRows, PeekRow } from "./folder-peek";
export type PeekCapability = "none" | "tree" | "top-level";
export const peekCapability = (mode: ViewMode): PeekCapability => mode === "details" ? "tree" : "none";

export function flatPeekEntries(root: string, entries: readonly FileEntry[]): PeekTree {
  return {
    entries, expanded: [],
    meta: new Map(entries.map(entry => [entry.path, { depth: 0, parentPath: root }])),
    indices: new Map(entries.map((entry, index) => [entry.path, index])),
  };
}
export function flatPeekRows(tree: PeekTree, creating: boolean): PeekRows {
  const offset = Number(creating);
  const rows: PeekRow[] = creating ? [{ kind: "create", key: "create" }] : [];
  tree.entries.forEach((entry, entryIndex) => rows.push({ kind: "entry", key: `entry:${entry.path}`, entry, entryIndex, ...tree.meta.get(entry.path)!, expanded: false }));
  return { rows, groups: [], entryToRow: tree.entries.map((_, index) => index + offset), rowToEntry: rows.map(row => row.kind === "entry" ? row.entryIndex : null) };
}

export function resolvePeekCommandTarget(entry: FileEntry | null | undefined, meta: ReadonlyMap<string, PeekMeta>): string | null {
  if (!entry) return null;
  if (entry.kind === "directory") return entry.path;
  const placement = meta.get(entry.path);
  return placement && placement.depth > 0 ? placement.parentPath : null;
}
export function resolvePeekEscape(entry: FileEntry | null | undefined, meta: ReadonlyMap<string, PeekMeta>): string | null {
  const placement = entry && meta.get(entry.path);
  return placement && placement.depth > 0 ? placement.parentPath : null;
}

export function entryIndicesForRows(layout: PeekRows, rows: readonly number[]): number[] {
  return rows.flatMap(row => layout.rowToEntry[row] == null ? [] : [layout.rowToEntry[row]!]);
}
