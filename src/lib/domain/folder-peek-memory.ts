/** Bounded expansion membership, available while the lazy peek session loads. */
import type { FileEntry } from "./file";
import { coverageOf, pathComparison } from "./path";

export type ExpandedPaths = ReadonlyMap<string, number>;

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


/** Session-only full-flow choices, most recently chosen last, with the same
 * bounded path memory as expansion membership. Collapsing does not reset a choice. */
export function rememberFullFlowPath(paths: ReadonlySet<string>, path: string, cap = 500): ReadonlySet<string> {
  const next = new Set(paths);
  next.delete(path);
  next.add(path);
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 500;
  while (next.size > limit) next.delete(next.values().next().value!);
  return next;
}
