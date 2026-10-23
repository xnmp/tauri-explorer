/** Bounded expansion membership, available while the lazy peek session loads. */
import type { FileEntry, ViewMode } from "./file";
import type { PeekCapability } from "./folder-peek-flat";
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


export type ListPeekExpansion = "column" | "full";

export const isListPeekExpansion = (value: unknown): value is ListPeekExpansion => value === "column" || value === "full";

/** What a pane knows about a folder when asked to remember a presentation
 * choice (List grip rows, Tiles panel height, List stage) for it. */
export interface PeekPresentationTarget {
  capability: PeekCapability;
  /** A drag's spring-loaded peek: compact, transient, never remembered (#1242). */
  temporary: boolean;
}

/** Admission shared by every remembered presentation choice. Each writer keeps
 * its own value validation on top of this. */
export function canRememberPeekPresentation(target: PeekPresentationTarget): boolean {
  return target.capability !== "none" && !target.temporary;
}

export interface ListStageTarget extends PeekPresentationTarget {
  viewMode: ViewMode;
  /** In the user's expanded set. */
  permanent: boolean;
  /** Projected tree depth; undefined when the folder is not projected. */
  depth: number | undefined;
}

/** The one eligibility policy for List column/full-flow stages: an open,
 * permanent, top-level folder of a peeking List view. */
export function canAcquireListStage(target: ListStageTarget, stage: unknown): stage is ListPeekExpansion {
  return isListPeekExpansion(stage) && canRememberPeekPresentation(target)
    && target.viewMode === "list" && target.permanent && target.depth === 0;
}

/** Session-only List presentation choices, most recently chosen last. A single
 * bounded map keeps the column and full-flow stages mutually exclusive. */
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
