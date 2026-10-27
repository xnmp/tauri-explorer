/** Session-only folder expansion policies and fixed-height tree row geometry. */
import type { FileEntry } from "./file";
import { flatPeekEntries, flatPeekRows, occurrenceKey } from "./folder-peek-flat";
import type { LineageChildren, LineageGroup } from "./entry-lineage";
import type { PeekCapability } from "./folder-peek-flat";
export { canPeekAt, peekCapability, resolvePeekCommandTarget, resolvePeekEscape, entryIndicesForRows, shouldToggleOnRowClick, rowClickOwnsPeek, caretlessDoubleClickNotice } from "./folder-peek-flat";
export type { PeekCapability, PeekSurface, RowClickInput, RowPeekTarget } from "./folder-peek-flat";
import { pathComparison } from "./path";

import type { ExpandedPaths } from "./folder-peek-memory";
export { toggleExpanded, collapseSubtree, pruneExpanded } from "./folder-peek-memory";
export type { ExpandedPaths } from "./folder-peek-memory";
/** An occurrence's placement. `parentPath` is the folder holding the file;
 * `parentKey`, present only beneath a lineage occurrence, is the parent
 * row's occurrence key (a file or a lineage group). */
export interface PeekMeta { depth: number; parentPath: string; parentKey?: string }
export interface PeekListing {
  status: "loading" | "loaded" | "error";
  entries: readonly FileEntry[];
  error?: string;
  showLoading?: boolean;
}

/**
 * Per-folder memory that lives as long as the folder stays expanded (Tiles panel
 * sides, §9.1): `placed` overrides, a remembered value of a folder still
 * expanded but not placed this time (another directory is shown, or another view)
 * is kept, and a folder that left `expanded` is forgotten. Returns `previous`
 * itself when nothing changed, so a store can skip publishing.
 */
export function rememberWhileExpanded<V>(previous: ReadonlyMap<string, V>, placed: ReadonlyMap<string, V>, expanded: ExpandedPaths): ReadonlyMap<string, V> {
  const next = new Map<string, V>();
  for (const [path, value] of previous) if (expanded.has(path) && !placed.has(path)) next.set(path, value);
  for (const [path, value] of placed) if (expanded.has(path)) next.set(path, value);
  if (next.size === previous.size && [...next].every(([path, value]) => previous.has(path) && previous.get(path) === value)) return previous;
  return next;
}

/**
 * The expanded set the projection renders: the user's expanded paths plus the
 * temporary (spring-loaded, #1242) peeks of a live drag. Temporary paths take
 * ordinal 0, below every user ordinal (>= 1), so they never win a watch slot
 * from a user peek; they never enter the stored set itself.
 */
export function withTemporaryPeeks(expanded: ExpandedPaths, temporary: readonly string[]): ExpandedPaths {
  if (!temporary.length) return expanded;
  const next = new Map(expanded);
  for (const path of temporary) if (!next.has(path)) next.set(path, 0);
  return next;
}

export function choosePeekWatches(reachable: readonly string[], expanded: ExpandedPaths, cap = 16): string[] {
  return [...reachable].sort((a, b) => (expanded.get(b) ?? -1) - (expanded.get(a) ?? -1)).slice(0, cap);
}

export interface PeekTree {
  /** The listed directory: the parent of every depth-0 entry. */
  root: string;
  /** Visible file occurrences in order; a path may repeat (lineage merges). */
  entries: readonly FileEntry[];
  /** Occurrence key per entry (`peekKeyAt`); absent when every key is its path. */
  keys?: readonly string[];
  /** Placement by occurrence key; a repeated path also answers by its path
   * with its first occurrence. */
  meta: ReadonlyMap<string, PeekMeta>;
  /** Open folder peeks: the folders whose listings are loaded and watched. */
  expanded: readonly string[];
  /** Open lineage peeks: files whose lineage children are shown (by path). */
  lineageOpen?: readonly string[];
  /** Lineage group rows, in order. */
  headers?: readonly PeekHeader[];
}

/** One level of the tree: its projected children admitted for their parent
 * (normalized key present, direct child) with the keys computed once. */
export interface PeekLevel { entries: readonly FileEntry[]; keys: readonly string[] }
export type PeekLevelCache = (
  listing: readonly FileEntry[], parent: string, projectionKey: string,
  project: (entries: readonly FileEntry[]) => readonly FileEntry[],
) => PeekLevel;

/** Pane-lifetime memo of level projections, keyed by listing snapshot
 * identity (snapshots are immutable revisions) plus the parent and every
 * projection input. A root filter keystroke or one level's publish therefore
 * re-projects only that level; sort and hidden-rule changes re-project all. */
export function createPeekLevelCache(windows: boolean): PeekLevelCache {
  const paths = pathComparison(windows);
  const cache = new WeakMap<readonly FileEntry[], { parent: string; projectionKey: string; level: PeekLevel }>();
  return (listing, parent, projectionKey, project) => {
    const hit = cache.get(listing);
    if (hit && hit.parent === parent && hit.projectionKey === projectionKey) return hit.level;
    const parentKey = paths.key(parent);
    const entries: FileEntry[] = [];
    const keys: string[] = [];
    // Flat virtual/provider roots are still valid listings; tree admission is
    // stricter, rejecting malformed and cross-parent backend data.
    for (const entry of parentKey === null ? [] : project(listing)) {
      const key = paths.key(entry.path);
      if (key === null || paths.parentKey(key) !== parentKey) continue;
      entries.push(entry); keys.push(key);
    }
    const level = { entries, keys };
    cache.set(listing, { parent, projectionKey, level });
    return level;
  };
}

/** Lineage children of the listed files (lineage peek, `entry-lineage.ts`). */
export interface PeekLineage { children(path: string): LineageChildren | undefined }

/** A lineage group row's place in the tree: before `tree.entries[at]` (or at the end). */
export interface PeekHeader { key: string; depth: number; parentKey: string; at: number; group: LineageGroup; expanded: boolean }

type Frame =
  | { kind: "folder"; level: PeekLevel; offset: number; parent: string; parentKey: string; depth: number }
  | { kind: "lineage"; items: readonly (FileEntry | LineageGroup)[]; offset: number; parentKey: string; depth: number };

export function flattenPeekEntries(options: {
  root: string;
  entries: readonly FileEntry[];
  expanded: ExpandedPaths;
  listing: (path: string) => readonly FileEntry[] | undefined;
  project: (entries: readonly FileEntry[], parent: string) => readonly FileEntry[];
  capability: PeekCapability;
  windows: boolean;
  /** Reused across passes by a pane; a fresh cache otherwise. */
  levels?: PeekLevelCache;
  /** Everything `project` reads besides the listing (sort, hidden rules). */
  projectionKey?: (parent: string) => string;
  /** Lineage grouping of the root listing: `entries` are then its roots, and
   * an expanded file with lineage children opens like a folder (§3). */
  lineage?: PeekLineage;
}): PeekTree {
  if (options.capability === "none") return flatPeekEntries(options.root, options.entries);
  const levels = options.levels ?? createPeekLevelCache(options.windows);
  const projectionKey = options.projectionKey ?? (() => "");
  const { lineage } = options;
  const entries: FileEntry[] = [];
  const keys: string[] = [];
  let repeated = false;
  const meta = new Map<string, PeekMeta>();
  const expanded: string[] = [];
  const lineageOpen = new Set<string>();
  const headers: PeekHeader[] = [];
  const seen = new Set<string>();
  // The root arrives already projected (filtered and sorted) by its owner.
  const stack: Frame[] = [{ kind: "folder", level: levels(options.entries, options.root, "root", items => items), offset: 0, parent: options.root, parentKey: options.root, depth: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    let entry: FileEntry;
    let key: string;
    let placement: PeekMeta;
    if (frame.kind === "folder") {
      if (frame.offset === frame.level.entries.length) { stack.pop(); continue; }
      const index = frame.offset++;
      entry = frame.level.entries[index];
      // A folder's children are keyed by path (their path names the chain)
      // unless the folder itself sits beneath a lineage occurrence.
      const plain = frame.parentKey === frame.parent;
      key = plain ? entry.path : occurrenceKey(frame.parentKey, entry.path);
      const identity = plain ? frame.level.keys[index] : key;
      if (seen.has(identity)) continue;
      seen.add(identity);
      placement = plain ? { depth: frame.depth, parentPath: frame.parent } : { depth: frame.depth, parentPath: frame.parent, parentKey: frame.parentKey };
    } else {
      if (frame.offset === frame.items.length) { stack.pop(); continue; }
      const item = frame.items[frame.offset++];
      if ("members" in item) {
        const groupKey = occurrenceKey(frame.parentKey, item.id);
        const open = options.expanded.has(item.id);
        headers.push({ key: groupKey, depth: frame.depth, parentKey: frame.parentKey, at: entries.length, group: item, expanded: open });
        if (open) stack.push({ kind: "lineage", items: item.members, offset: 0, parentKey: groupKey, depth: frame.depth + 1 });
        continue;
      }
      entry = item;
      key = occurrenceKey(frame.parentKey, entry.path);
      if (seen.has(key)) continue;
      seen.add(key);
      placement = { depth: frame.depth, parentPath: options.root, parentKey: frame.parentKey };
    }
    if (key !== entry.path) repeated = true;
    entries.push(entry);
    keys.push(key);
    meta.set(key, placement);
    // A repeated path also answers by its path with its first occurrence.
    if (!meta.has(entry.path)) meta.set(entry.path, placement);
    if (!options.expanded.has(entry.path)) continue;
    if (entry.kind === "directory") {
      if (options.capability === "top-level" && placement.depth > 0) continue;
      if (!expanded.includes(entry.path)) expanded.push(entry.path);
      const children = options.listing(entry.path);
      if (!children) continue;
      const level = levels(children, entry.path, projectionKey(entry.path), items => options.project(items, entry.path));
      stack.push({ kind: "folder", level, offset: 0, parent: entry.path, parentKey: key === entry.path ? entry.path : key, depth: placement.depth + 1 });
      continue;
    }
    const children = lineage?.children(entry.path);
    if (!children || (!children.groups.length && !children.direct.length)) continue;
    lineageOpen.add(entry.path);
    stack.push({ kind: "lineage", items: [...children.groups, ...children.direct], offset: 0, parentKey: key, depth: placement.depth + 1 });
  }
  return {
    root: options.root, entries, meta, expanded,
    ...(repeated ? { keys } : {}),
    ...(lineageOpen.size ? { lineageOpen: [...lineageOpen] } : {}),
    ...(headers.length ? { headers } : {}),
  };
}

export type PeekRow = ({ kind: "entry"; key: string; entry: FileEntry; entryIndex: number; expanded: boolean } & PeekMeta)
  | { kind: "peek-state"; key: string; parentPath: string; depth: number; message: string }
  /** A lineage group (not a file): "with B" over the children P shares with B. */
  | { kind: "lineage-group"; key: string; occurrence: string; parentKey: string; depth: number; group: LineageGroup; expanded: boolean }
  | { kind: "create"; key: string };
export interface PeekGroup { path: string; depth: number; startRow: number; endRow: number }
export interface PeekRows { rows: PeekRow[]; entryToRow: number[]; rowToEntry: (number | null)[]; groups: PeekGroup[] }

export function buildPeekRows(tree: PeekTree, listing: (path: string) => PeekListing | undefined, creating = false): PeekRows {
  // Nothing expanded is a flat listing: same rows, without per-entry lookups.
  if (!tree.expanded.length && !tree.lineageOpen?.length && !tree.headers?.length) return flatPeekRows(tree, creating);
  const rows: PeekRow[] = creating ? [{ kind: "create", key: "create" }] : [];
  const groups: PeekGroup[] = [];
  const active: PeekGroup[] = [];
  const entryToRow: number[] = [];
  const expanded = new Set(tree.expanded);
  const open = tree.lineageOpen?.length ? new Set([...tree.expanded, ...tree.lineageOpen]) : expanded;
  const headers = tree.headers ?? [];
  let header = 0;
  const close = (depth: number) => { while (active.length && active.at(-1)!.depth >= depth) active.pop()!.endRow = rows.length; };
  const openGroup = (path: string, depth: number) => {
    const group = { path, depth, startRow: rows.length, endRow: rows.length };
    groups.push(group);
    active.push(group);
  };
  const emitHeaders = (before: number) => {
    for (; header < headers.length && headers[header].at <= before; header++) {
      const item = headers[header];
      close(item.depth);
      rows.push({ kind: "lineage-group", key: `lineage:${item.key}`, occurrence: item.key, parentKey: item.parentKey, depth: item.depth, group: item.group, expanded: item.expanded });
      if (item.expanded) openGroup(item.key, item.depth);
    }
  };
  tree.entries.forEach((entry, entryIndex) => {
    emitHeaders(entryIndex);
    const key = tree.keys?.[entryIndex] ?? entry.path;
    const placement = tree.meta.get(key)!;
    close(placement.depth);
    entryToRow.push(rows.length);
    rows.push({ kind: "entry", key: `entry:${key}`, entry, entryIndex, depth: placement.depth, parentPath: placement.parentPath,
      ...(placement.parentKey !== undefined ? { parentKey: placement.parentKey } : {}), expanded: open.has(entry.path) });
    if (!open.has(entry.path)) return;
    openGroup(key, placement.depth);
    if (!expanded.has(entry.path) || entry.kind !== "directory") return;
    const state = listing(entry.path);
    const next = tree.entries[entryIndex + 1];
    const nextKey = tree.keys?.[entryIndex + 1] ?? next?.path;
    const hasChildren = next && tree.meta.get(nextKey!)!.depth > placement.depth;
    const message = state?.status === "error" ? `Can't open folder: ${state.error}`
      : state?.status === "loading" ? state.showLoading ? "Loading…" : null
      : state?.status === "loaded" && !hasChildren ? "Empty folder" : null;
    if (message) rows.push({ kind: "peek-state", key: `state:${key}`, parentPath: entry.path, depth: placement.depth + 1, message });
  });
  emitHeaders(Infinity);
  for (const group of active) group.endRow = rows.length;
  return { rows, entryToRow, rowToEntry: rows.map(row => row.kind === "entry" ? row.entryIndex : null), groups };
}

/** Each entry's tree position among its siblings (entries sharing its parent),
 * indexed by entry index. A virtualized tree has to state these itself:
 * assistive technology would otherwise count only the mounted siblings. */
export interface PeekTreePositions { readonly posinset: readonly number[]; readonly setsize: readonly number[] }
export function peekTreePositions(rows: readonly PeekRow[]): PeekTreePositions {
  const counts = new Map<string, number>();
  const posinset: number[] = [];
  const parents: string[] = [];
  for (const row of rows) {
    if (row.kind !== "entry") continue;
    const parent = row.parentKey ?? row.parentPath;
    const position = (counts.get(parent) ?? 0) + 1;
    counts.set(parent, position);
    posinset[row.entryIndex] = position;
    parents[row.entryIndex] = parent;
  }
  return { posinset, setsize: parents.map(parent => counts.get(parent)!) };
}

/** Tree positions by entry index. With nothing expanded every entry is a
 * top-level sibling, so the lookup is arithmetic and allocates nothing per
 * entry: a 10,000-entry List with no open card pays no tree bookkeeping. */
export interface PeekTreePositionLookup { posinset(entryIndex: number): number; setsize(entryIndex: number): number }
export function peekTreePositionLookup(layout: PeekRows): PeekTreePositionLookup {
  if (!layout.groups.length) {
    const size = layout.entryToRow.length;
    return { posinset: entryIndex => entryIndex + 1, setsize: () => size };
  }
  const { posinset, setsize } = peekTreePositions(layout.rows);
  return { posinset: entryIndex => posinset[entryIndex], setsize: entryIndex => setsize[entryIndex] };
}
