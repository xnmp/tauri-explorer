/** Session-only folder expansion policies and fixed-height tree row geometry. */
import type { FileEntry } from "./file";
import { flatPeekEntries } from "./folder-peek-flat";
import type { PeekCapability } from "./folder-peek-flat";
export { canPeekAt, peekCapability, resolvePeekCommandTarget, resolvePeekEscape, entryIndicesForRows, shouldToggleOnRowClick } from "./folder-peek-flat";
export type { PeekCapability, PeekSurface, RowClickInput } from "./folder-peek-flat";
import { coverageOf, pathComparison } from "./path";

export type ExpandedPaths = ReadonlyMap<string, number>;
export interface PeekMeta { depth: number; parentPath: string }
export interface PeekListing {
  status: "loading" | "loaded" | "error";
  entries: readonly FileEntry[];
  error?: string;
  showLoading?: boolean;
}

export function toggleExpanded(expanded: ExpandedPaths, path: string, ordinal: number, cap = 500): Map<string, number> {
  const next = new Map(expanded);
  if (next.delete(path)) return next;
  next.set(path, ordinal);
  if (next.size > cap) {
    const oldest = [...next].reduce((a, b) => a[1] < b[1] ? a : b);
    next.delete(oldest[0]);
  }
  return next;
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

/** Remove every expanded path at or below any of `roots`. */
export function collapseSubtree(expanded: ExpandedPaths, roots: readonly string[], windows: boolean): Map<string, number> {
  const covered = coverageOf(roots, windows);
  return new Map([...expanded].filter(([path]) => !covered(path)));
}

/** Only a complete raw snapshot can establish that a branch disappeared. */
export function pruneExpanded(expanded: ExpandedPaths, parent: string, entries: readonly FileEntry[], windows: boolean): Map<string, number> {
  const paths = pathComparison(windows);
  const directories = new Set(entries.filter(e => e.kind === "directory" && paths.sameParent(e.path, parent)).map(e => paths.key(e.path)));
  return new Map([...expanded].filter(([path]) => {
    if (paths.same(path, parent) || !paths.contains(path, parent)) return true;
    let child = paths.key(path)!;
    while (!paths.sameParent(child, parent)) {
      const above = paths.parent(child);
      if (!above || above === child) return false;
      child = above;
    }
    return directories.has(paths.key(child));
  }));
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
  entries: readonly FileEntry[];
  meta: ReadonlyMap<string, PeekMeta>;
  indices: ReadonlyMap<string, number>;
  expanded: readonly string[];
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
}): PeekTree {
  if (options.capability === "none") return flatPeekEntries(options.root, options.entries);
  const levels = options.levels ?? createPeekLevelCache(options.windows);
  const projectionKey = options.projectionKey ?? (() => "");
  const entries: FileEntry[] = [];
  const meta = new Map<string, PeekMeta>();
  const indices = new Map<string, number>();
  const expanded: string[] = [];
  const seen = new Set<string>();
  // The root arrives already projected (filtered and sorted) by its owner.
  const stack = [{ level: levels(options.entries, options.root, "root", items => items), offset: 0, parent: options.root, depth: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.offset === frame.level.entries.length) { stack.pop(); continue; }
    const index = frame.offset++;
    const entry = frame.level.entries[index];
    const key = frame.level.keys[index];
    if (seen.has(key)) continue;
    seen.add(key);
    indices.set(entry.path, entries.length);
    entries.push(entry);
    meta.set(entry.path, { depth: frame.depth, parentPath: frame.parent });
    if (entry.kind !== "directory" || (options.capability === "top-level" && frame.depth > 0) || !options.expanded.has(entry.path)) continue;
    expanded.push(entry.path);
    const children = options.listing(entry.path);
    if (!children) continue;
    const level = levels(children, entry.path, projectionKey(entry.path), items => options.project(items, entry.path));
    stack.push({ level, offset: 0, parent: entry.path, depth: frame.depth + 1 });
  }
  return { entries, meta, indices, expanded };
}

export type PeekRow = ({ kind: "entry"; key: string; entry: FileEntry; entryIndex: number; expanded: boolean } & PeekMeta)
  | { kind: "peek-state"; key: string; parentPath: string; depth: number; message: string }
  | { kind: "create"; key: string };
export interface PeekGroup { path: string; depth: number; startRow: number; endRow: number }
export interface PeekRows { rows: PeekRow[]; entryToRow: number[]; rowToEntry: (number | null)[]; groups: PeekGroup[] }

export function buildPeekRows(tree: PeekTree, listing: (path: string) => PeekListing | undefined, creating = false): PeekRows {
  const rows: PeekRow[] = creating ? [{ kind: "create", key: "create" }] : [];
  const groups: PeekGroup[] = [];
  const active: PeekGroup[] = [];
  const entryToRow: number[] = [];
  const expanded = new Set(tree.expanded);
  tree.entries.forEach((entry, entryIndex) => {
    const placement = tree.meta.get(entry.path)!;
    while (active.length && active.at(-1)!.depth >= placement.depth) active.pop()!.endRow = rows.length;
    entryToRow.push(rows.length);
    rows.push({ kind: "entry", key: `entry:${entry.path}`, entry, entryIndex, depth: placement.depth, parentPath: placement.parentPath, expanded: expanded.has(entry.path) });
    if (!expanded.has(entry.path)) return;
    const group = { path: entry.path, depth: placement.depth, startRow: rows.length, endRow: rows.length };
    groups.push(group);
    active.push(group);
    const state = listing(entry.path);
    const next = tree.entries[entryIndex + 1];
    const hasChildren = next && tree.meta.get(next.path)!.depth > placement.depth;
    const message = state?.status === "error" ? `Can't open folder: ${state.error}`
      : state?.status === "loading" ? state.showLoading ? "Loading…" : null
      : state?.status === "loaded" && !hasChildren ? "Empty folder" : null;
    if (message) rows.push({ kind: "peek-state", key: `state:${entry.path}`, parentPath: entry.path, depth: placement.depth + 1, message });
  });
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
    const position = (counts.get(row.parentPath) ?? 0) + 1;
    counts.set(row.parentPath, position);
    posinset[row.entryIndex] = position;
    parents[row.entryIndex] = row.parentPath;
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
