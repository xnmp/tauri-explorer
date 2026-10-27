/** Pane-level folder-peek decisions an explorer applies to its own state:
 * pruning selection hidden by a projection change, and drop targets inside
 * spring-loaded peeks (#1242). Imported only by the explorer store. */
import type { FileEntry } from "./file";
import type { PeekMeta, PeekTree } from "./folder-peek";
import { OCCURRENCE_SEPARATOR, occurrencePath, parentKeyOf, peekKeyAt } from "./folder-peek-flat";

/** Peeked children a projection change hid, and where a hidden cursor (or,
 * failing that, anchor) lands: its nearest still-shown ancestor, or null when
 * none is shown. Null when nothing hid; `refocus` is absent when neither the
 * cursor nor the anchor hid.
 *
 * A path hides only when no occurrence of it stays visible (a lineage merge
 * output shows under each parent). The walk climbs from the cursor's own
 * occurrence (`cursorKey`, else its first) and lands on the first visible
 * file; `refocusKey` names that occurrence. */
export function prunePeekSelection(before: Pick<PeekTree, "entries" | "meta" | "keys">, after: readonly FileEntry[],
  selected: Iterable<string>, cursor: string | null, anchor: string | null,
  cursorKey: string | null = cursor, anchorKey: string | null = anchor): { selected: string[]; refocus?: string | null; refocusKey?: string } | null {
  const visible = new Set(after.map(e => e.path));
  const hidden = new Set<string>();
  before.entries.forEach((entry, index) => {
    if (!visible.has(entry.path) && (before.meta.get(peekKeyAt(before, index))?.depth ?? 0) > 0) hidden.add(entry.path);
  });
  if (!hidden.size) return null;
  const kept = [...selected].filter(path => !hidden.has(path));
  const cursorHidden = cursor && hidden.has(cursor);
  if (!cursorHidden && !(anchor && hidden.has(anchor))) return { selected: kept };
  const from = cursorHidden ? cursor : anchor;
  const fromKey = cursorHidden ? cursorKey : anchorKey;
  let key: string | null = fromKey !== null && occurrencePath(fromKey) === from && before.meta.has(fromKey) ? fromKey : from;
  while (key && !visible.has(occurrencePath(key))) {
    // A lineage occurrence key ends with its own segment, so its prefix is its
    // parent (a group row has no placement of its own).
    const at = key.lastIndexOf(OCCURRENCE_SEPARATOR);
    const placement = before.meta.get(key);
    key = at > 0 ? key.slice(0, at) : placement ? parentKeyOf(placement) : null;
  }
  const refocus = key && occurrencePath(key);
  // `refocusKey` only when it differs from `refocus` (a nested lineage occurrence).
  return key === refocus || key === null ? { selected: kept, refocus } : { selected: kept, refocus, refocusKey: key };
}

/** The folder a drop on a row targets while it lies inside a temporary peek:
 * a file row's folder, or the directory itself (also a peek-state row). Null
 * outside temporary peeks; the walk stops at the pane root. */
export function springPeekDropFolder(path: string, kind: "directory" | "file" | "state",
  meta: ReadonlyMap<string, PeekMeta>, temporary: readonly string[], root: string): string | null {
  if (!temporary.length) return null;
  const folder = kind === "file" ? meta.get(path)?.parentPath : path;
  for (let at = folder; at && at !== root; at = meta.get(at)?.parentPath) {
    if (temporary.includes(at)) return folder!;
  }
  return null;
}
