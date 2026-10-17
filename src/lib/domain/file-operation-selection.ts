/** Explorer selections may span recursive parents and children. Native batch
 * APIs retain their own contracts; reduce only Explorer extraction boundaries. */
import type { FileEntry } from "./file";
import { pathComparison } from "./path";

type OperationRoots = { ok: true; entries: FileEntry[] } | { ok: false; error: string };
export function operationRoots(entries: readonly FileEntry[], windows: boolean): OperationRoots {
  const paths = pathComparison(windows);
  const directories = entries.filter(entry => entry.kind === "directory");
  const covers = (parent: FileEntry, child: FileEntry) => parent !== child && !paths.same(parent.path, child.path) && paths.contains(child.path, parent.path);
  if (directories.some(parent => parent.is_symlink && entries.some(child => covers(parent, child)))) {
    return { ok: false, error: "Select a symbolic link or its children separately before this operation." };
  }
  const seen = new Set<string>();
  return { ok: true, entries: entries.filter(entry => {
    const key = paths.key(entry.path) ?? entry.path;
    if (seen.has(key) || directories.some(parent => covers(parent, entry))) return false;
    seen.add(key); return true;
  }) };
}

export function operationDrag(entries: readonly FileEntry[], primary: FileEntry, windows: boolean) {
  const result = operationRoots(entries, windows);
  if (!result.ok) return result;
  const paths = pathComparison(windows);
  return { ...result, primary: result.entries.find(entry => paths.same(entry.path, primary.path))
    ?? result.entries.find(entry => entry.kind === "directory" && paths.contains(primary.path, entry.path)) ?? primary };
}
