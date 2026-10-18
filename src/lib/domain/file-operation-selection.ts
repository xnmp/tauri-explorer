/** Explorer selections may span recursive parents and children. Native batch
 * APIs retain their own contracts; reduce only Explorer extraction boundaries.
 *
 * Every pass is O(entries × depth): keys are normalized once, and coverage is
 * an ancestor walk against a Set of selected directory keys, so bulk actions
 * on thousands of siblings stay linear. */
import type { FileEntry } from "./file";
import { pathComparison } from "./path";

type OperationRoots = { ok: true; entries: FileEntry[] } | { ok: false; error: string };

/** Strict ancestors of a normalized key, nearest first. */
function* ancestors(key: string, parentKey: (key: string) => string): Generator<string> {
  for (let current = key, next = parentKey(current); next !== current; current = next, next = parentKey(current)) yield next;
}

export function operationRoots(entries: readonly FileEntry[], windows: boolean, visibleEntries: readonly FileEntry[] = entries): OperationRoots {
  const paths = pathComparison(windows);
  // A null key (relative, `..`, NUL) has no safe comparison: it neither covers
  // nor is covered, and deduplicates by its literal path.
  const keys = entries.map(entry => paths.key(entry.path));
  const directories = new Set<string>();
  entries.forEach((entry, index) => { if (entry.kind === "directory" && keys[index] !== null) directories.add(keys[index]!); });
  const covered = (key: string | null) => {
    if (key === null) return false;
    for (const ancestor of ancestors(key, paths.parentKey)) if (directories.has(ancestor)) return true;
    return false;
  };

  // A selected directory at or above a symlinked directory, plus a selected
  // entry below that link, would let the ancestor's batch reach through it.
  const links = new Set<string>();
  for (const entry of visibleEntries) {
    if (entry.kind !== "directory" || !entry.is_symlink) continue;
    const key = paths.key(entry.path);
    if (key !== null) links.add(key);
  }
  if (links.size) {
    const linksWithSelectedDescendants = new Set<string>();
    for (const key of keys) {
      if (key === null) continue;
      for (const ancestor of ancestors(key, paths.parentKey)) if (links.has(ancestor)) linksWithSelectedDescendants.add(ancestor);
    }
    for (const link of linksWithSelectedDescendants) {
      if (directories.has(link) || covered(link)) {
        return { ok: false, error: "Select a symbolic link or its children separately before this operation." };
      }
    }
  }

  const seen = new Set<string>();
  return { ok: true, entries: entries.filter((entry, index) => {
    const key = keys[index];
    const identity = key ?? entry.path;
    if (seen.has(identity) || covered(key)) return false;
    seen.add(identity); return true;
  }) };
}

export function operationDrag(entries: readonly FileEntry[], primary: FileEntry, windows: boolean, visibleEntries: readonly FileEntry[] = entries) {
  const result = operationRoots(entries, windows, visibleEntries);
  if (!result.ok) return result;
  const paths = pathComparison(windows);
  const primaryKey = paths.key(primary.path);
  // An uncomparable path can be neither matched nor covered.
  if (primaryKey === null) return { ...result, primary };
  const byKey = new Map<string, FileEntry>();
  for (const entry of result.entries) {
    const key = paths.key(entry.path);
    if (key !== null && !byKey.has(key)) byKey.set(key, entry);
  }
  // The dragged row itself, else the selected folder whose batch covers it.
  let reduced = byKey.get(primaryKey);
  for (const ancestor of reduced ? [] : ancestors(primaryKey, paths.parentKey)) {
    const candidate = byKey.get(ancestor);
    if (candidate?.kind === "directory") { reduced = candidate; break; }
  }
  return { ...result, primary: reduced ?? primary };
}

/** Compression names each archive member by its basename alone, so two
 * reduced roots with one name (children of different peeked folders) would
 * collide inside the archive. Names compare case-insensitively on Windows. */
export function archiveRoots(entries: readonly FileEntry[], windows: boolean, visibleEntries: readonly FileEntry[] = entries): OperationRoots {
  const result = operationRoots(entries, windows, visibleEntries);
  if (!result.ok) return result;
  const names = new Set<string>();
  for (const entry of result.entries) {
    const name = windows ? entry.name.toLowerCase() : entry.name;
    if (names.has(name)) return { ok: false, error: "Selected items have the same name" };
    names.add(name);
  }
  return result;
}
