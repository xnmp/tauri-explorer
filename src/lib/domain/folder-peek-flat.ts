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
/** Details and List (column flow, which is what List is while Folder Peek is
 * on) nest freely; Tiles panels show top-level folders only (#1241). */
export function peekCapability(surface: PeekSurface): PeekCapability {
  const { enabled, fileListing, builtinView, plainLocation, mode } = surface;
  if (!enabled || !fileListing || !builtinView || !plainLocation) return "none";
  return mode === "details" || mode === "list" ? "tree" : mode === "tiles" ? "top-level" : "none";
}

export interface RowPeekTarget {
  /** The surface draws expand carets; they own toggling, so a row click never does. */
  caretsShown: boolean;
  isDirectory: boolean;
  /** The pane can peek here (feature on, plain location, supporting view). */
  eligible: boolean;
}
export interface RowClickInput extends RowPeekTarget {
  modifiers: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean };
  /** The click ended a pointer drag or marquee. */
  wasDrag: boolean;
}

/** Caret-less peek (#1248) gives this folder row's mouse clicks to its peek.
 * A double-click is then two toggles that cancel out, so it does not also
 * navigate; Open (Enter) is the way into the folder (#1298). */
export function rowClickOwnsPeek(target: RowPeekTarget): boolean {
  return !target.caretsShown && target.isDirectory && target.eligible;
}

/** A plain primary click toggles the folder in addition to the ordinary
 * selection; modifier clicks and drag ends stay pure selection gestures. */
export function shouldToggleOnRowClick(input: RowClickInput): boolean {
  const { ctrlKey, shiftKey, metaKey, altKey } = input.modifiers;
  return rowClickOwnsPeek(input) && !input.wasDrag && !(ctrlKey || shiftKey || metaKey || altKey);
}

/** The toast a refused folder double-click shows; `openShortcut` is the Open
 * command's current binding, absent when the user unbound it. */
export function caretlessDoubleClickNotice(openShortcut: string | undefined): string {
  const how = openShortcut ? `Use ${openShortcut}` : "Use Open in the context menu";
  return `Double-click is disabled while peek carets are off. ${how} to navigate into folders.`;
}

/**
 * The placement of every entry in a flat listing is the same, so the flat
 * projection keeps no per-entry records (#1416): `meta` answers from a path
 * index built on its first lookup, and rows share their constant fields. A
 * 100k-entry folder otherwise held a meta object and two map slots per entry,
 * built on every listing although plain browsing never reads them.
 */
class FlatPeekMeta implements ReadonlyMap<string, PeekMeta> {
  #paths: ReadonlySet<string> | undefined;
  readonly #listing: readonly FileEntry[];
  readonly #placement: PeekMeta;
  constructor(root: string, listing: readonly FileEntry[]) {
    this.#listing = listing;
    this.#placement = { depth: 0, parentPath: root };
  }
  private get paths(): ReadonlySet<string> {
    return this.#paths ??= new Set(this.#listing.map(entry => entry.path));
  }
  get size() { return this.paths.size; }
  has(path: string) { return this.paths.has(path); }
  get(path: string) { return this.paths.has(path) ? this.#placement : undefined; }
  forEach(callback: (value: PeekMeta, key: string, map: ReadonlyMap<string, PeekMeta>) => void, thisArg?: unknown) {
    for (const path of this.paths) callback.call(thisArg, this.#placement, path, this);
  }
  *entries(): MapIterator<[string, PeekMeta]> { for (const path of this.paths) yield [path, this.#placement]; }
  *keys(): MapIterator<string> { yield* this.paths; }
  *values(): MapIterator<PeekMeta> { for (const _ of this.paths) yield this.#placement; }
  [Symbol.iterator]() { return this.entries(); }
}

export function flatPeekEntries(root: string, entries: readonly FileEntry[]): PeekTree {
  return { root, entries, expanded: [], meta: new FlatPeekMeta(root, entries) };
}

/**
 * One flat entry row: per-row fields only, the constant ones on the prototype
 * and `key` a getter (#1416). Rows are therefore not plain objects: spreading
 * or `Object.keys` omits kind/depth/expanded/key, and each `key` read builds
 * a new string. Read fields by name.
 */
class FlatEntryRow {
  declare readonly kind: "entry";
  declare readonly depth: 0;
  declare readonly expanded: false;
  constructor(readonly entry: FileEntry, readonly entryIndex: number, readonly parentPath: string) {}
  get key() { return `entry:${this.entry.path}`; }
}
Object.defineProperties(FlatEntryRow.prototype, {
  kind: { value: "entry", enumerable: true },
  depth: { value: 0, enumerable: true },
  expanded: { value: false, enumerable: true },
});

export function flatPeekRows(tree: PeekTree, creating: boolean): PeekRows {
  const offset = Number(creating);
  const rows: PeekRow[] = creating ? [{ kind: "create", key: "create" }] : [];
  tree.entries.forEach((entry, entryIndex) => rows.push(new FlatEntryRow(entry, entryIndex, tree.root)));
  return { rows, groups: [], entryToRow: tree.entries.map((_, index) => index + offset), rowToEntry: rows.map(row => row.kind === "entry" ? row.entryIndex : null) };
}

/** Whether a folder at `depth` can open a peek: Tiles (top-level) peeks only the
 * current directory's own folders; a panel's subfolder is a leaf, like a file. */
export const canPeekAt = (capability: PeekCapability, depth: number): boolean =>
  capability === "tree" || (capability === "top-level" && depth === 0);

/** The folder "Peek into Folder" toggles: the cursor's folder when it can peek,
 * else the peek that holds the cursor entry (closing it). */
export function resolvePeekCommandTarget(entry: FileEntry | null | undefined, meta: ReadonlyMap<string, PeekMeta>, capability: PeekCapability = "tree"): string | null {
  if (!entry || capability === "none") return null;
  const placement = meta.get(entry.path);
  if (entry.kind === "directory" && canPeekAt(capability, placement?.depth ?? 0)) return entry.path;
  return placement && placement.depth > 0 ? placement.parentPath : null;
}
export function resolvePeekEscape(entry: FileEntry | null | undefined, meta: ReadonlyMap<string, PeekMeta>): string | null {
  const placement = entry && meta.get(entry.path);
  return placement && placement.depth > 0 ? placement.parentPath : null;
}

/** Drop redirects use the live projection, never a guessed path parent. Root
 * files retain their ordinary behaviour; nested files target their open peek. */
export function permanentPeekDropFolder(path: string, kind: "directory" | "file" | "state",
  meta: ReadonlyMap<string, PeekMeta>, expanded: ReadonlySet<string>): string | null {
  const placement = meta.get(path);
  if (kind === "state") return expanded.has(path) ? path : null;
  if (!placement || placement.depth < 1 || !expanded.has(placement.parentPath)) return null;
  return kind === "directory" ? path : placement.parentPath;
}

export function entryIndicesForRows(layout: PeekRows, rows: readonly number[]): number[] {
  return rows.flatMap(row => layout.rowToEntry[row] == null ? [] : [layout.rowToEntry[row]!]);
}
