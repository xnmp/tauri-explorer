/** Pane-level folder-peek decisions an explorer applies to its own state:
 * pruning selection hidden by a projection change, and drop targets inside
 * spring-loaded peeks (#1242). Imported only by the explorer store. */
import type { FileEntry } from "./file";
import type { PeekMeta, PeekTree } from "./folder-peek";

/** Peeked children a projection change hid, and where a hidden cursor (or,
 * failing that, anchor) lands: its nearest still-shown ancestor, or null when
 * none is shown. Null when nothing hid; `refocus` is absent when neither the
 * cursor nor the anchor hid. */
export function prunePeekSelection(before: Pick<PeekTree, "entries" | "meta">, after: readonly FileEntry[],
  selected: Iterable<string>, cursor: string | null, anchor: string | null): { selected: string[]; refocus?: string | null } | null {
  const visible = new Set(after.map(e => e.path));
  const hidden = new Set(before.entries.filter(e => (before.meta.get(e.path)?.depth ?? 0) > 0 && !visible.has(e.path)).map(e => e.path));
  if (!hidden.size) return null;
  const kept = [...selected].filter(path => !hidden.has(path));
  const cursorHidden = cursor && hidden.has(cursor);
  if (!cursorHidden && !(anchor && hidden.has(anchor))) return { selected: kept };
  let path = cursorHidden ? cursor : anchor;
  while (path && !visible.has(path)) path = before.meta.get(path)?.parentPath ?? null;
  return { selected: kept, refocus: path };
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
