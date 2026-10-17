/** Flat Details geometry and command admission, available before the first peek. */
import type { FileEntry, ViewMode } from "./file";
import type { PeekMeta, PeekTree, PeekRows, PeekRow } from "./folder-peek";
export type PeekCapability = "none" | "tree" | "top-level";
/** Everything that decides whether a pane may peek. Each "no" — the Folder Peek
 * setting off, a git-graph/plugin surface, a virtual or provider location, or a
 * view without peek support — is the same capability "none": no carets, no peek
 * resources, flat entries. Remembered membership is retained by the caller. */
export interface PeekSurface {
  enabled: boolean;
  fileListing: boolean;
  builtinView: boolean;
  plainLocation: boolean;
  mode: ViewMode;
}
export function peekCapability(surface: PeekSurface): PeekCapability {
  const { enabled, fileListing, builtinView, plainLocation, mode } = surface;
  return enabled && fileListing && builtinView && plainLocation && mode === "details" ? "tree" : "none";
}

export interface RowClickInput {
  /** The surface draws expand carets; they own toggling, so a row click never does. */
  caretsShown: boolean;
  isDirectory: boolean;
  /** The pane can peek here (feature on, plain location, supporting view). */
  eligible: boolean;
  modifiers: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean };
  /** The click ended a pointer drag or marquee. */
  wasDrag: boolean;
}

/** Caret-less peek (#1248): a plain primary click on a peekable folder row
 * toggles it in addition to the ordinary selection. Modifier clicks stay
 * pure selection gestures; the double-click's two clicks cancel out. */
export function shouldToggleOnRowClick(input: RowClickInput): boolean {
  const { ctrlKey, shiftKey, metaKey, altKey } = input.modifiers;
  return !input.caretsShown && input.isDirectory && input.eligible && !input.wasDrag
    && !(ctrlKey || shiftKey || metaKey || altKey);
}

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
