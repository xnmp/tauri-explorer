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
  // Nothing remembered below this folder: no need to index its listing (#1417).
  if (![...expanded.keys()].some(path => !paths.same(path, parent) && paths.contains(path, parent))) return new Map(expanded);
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


/** A List folder's expanded stages: its rows spilled below its header (capped,
 * #1365), every row in full flow, or the legacy scrollable column (#1324). */
export type ListPeekExpansion = "column" | "spill" | "full";

/** Session-only List presentation choices, most recently chosen last. A single
 * bounded map keeps the expanded stages mutually exclusive; the compact card is
 * the absence of a choice. */
export function rememberListExpansion(
  choices: ReadonlyMap<string, ListPeekExpansion>, path: string, mode: ListPeekExpansion, cap = 500,
): ReadonlyMap<string, ListPeekExpansion> {
  const next = new Map(choices);
  next.delete(path);
  next.set(path, mode);
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 500;
  while (next.size > limit) next.delete(next.keys().next().value!);
  return next;
}
