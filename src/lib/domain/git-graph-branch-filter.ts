/**
 * Branch-subset filter semantics for the git graph's filter popover
 * (#342, #411–#413, #515). Pure: the graph view owns persistence and the
 * side effects of a filter change (closing details, retiring navigation).
 *
 * A filter is `null` for "every branch" and an array for an explicit subset;
 * an empty array is a valid "no branches selected" state (#413).
 */
import type { BranchListEntry } from "./git-graph";

export type BranchFilter = readonly string[] | null;

/** Full ref identity for fork-point selection; shorthand names can collide. */
export function branchRef(branch: BranchListEntry): string {
  return `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`;
}

/** Case-insensitive substring search over the popover's branch list. */
export function filterBranchesByQuery<T extends BranchListEntry>(
  branches: readonly T[],
  query: string,
): T[] {
  const needle = query.toLowerCase();
  return branches.filter((branch) => branch.name.toLowerCase().includes(needle));
}

/** Whether `name` is part of the walked set. A branch the bulk remote-only
 *  toggle hides is never shown, whatever the per-branch selection says. */
export function isBranchShown(
  name: string,
  filter: BranchFilter,
  hiddenAsRemoteOnly: boolean,
): boolean {
  if (hiddenAsRemoteOnly) return false;
  return filter === null || filter.includes(name);
}

/** Collapse a selection equal to the whole list back to "all" (null). */
function normalize(selection: readonly string[], allNames: readonly string[]): string[] | null {
  return selection.length === allNames.length ? null : [...selection];
}

/** Checkbox semantics: from "all", unchecking X shows everything but X;
 *  re-checking the last missing branch collapses back to "all". */
export function toggleBranchInFilter(
  filter: BranchFilter,
  allNames: readonly string[],
  name: string,
): string[] | null {
  const current = filter ?? allNames;
  const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
  return normalize(next, allNames);
}

/** Select/deselect-all (#413): everything shown → none; anything else → all. */
export function toggleAllBranchesFilter(filter: BranchFilter): string[] | null {
  return filter === null ? [] : null;
}

/** Distinct, sorted, non-empty branch-creator names (#376). */
export function authorOptions(authors: ReadonlyMap<string, string>): string[] {
  return [...new Set([...authors.values()].filter((author) => author))].sort();
}

/** Branches an author checkbox governs. Branches the bulk remote-only toggle
 *  hides (#515) are out of play on the per-branch axis, so they neither
 *  uncheck their author nor get (de)selected through it. */
export function branchesByAuthor(
  branches: readonly BranchListEntry[],
  authors: ReadonlyMap<string, string>,
  author: string,
  isHiddenAsRemoteOnly: (name: string) => boolean,
): string[] {
  return branches
    .filter((branch) => authors.get(branch.name) === author && !isHiddenAsRemoteOnly(branch.name))
    .map((branch) => branch.name);
}

/** An author reads as checked when every branch they govern is shown. */
export function isAuthorShown(
  authorBranches: readonly string[],
  isShown: (name: string) => boolean,
): boolean {
  return authorBranches.length > 0 && authorBranches.every(isShown);
}

/** Ticking an author selects all their branches; unticking deselects them. */
export function toggleAuthorInFilter(
  filter: BranchFilter,
  allNames: readonly string[],
  authorBranches: readonly string[],
): string[] | null {
  const current = new Set(filter ?? allNames);
  const allSelected = authorBranches.length > 0 && authorBranches.every((n) => current.has(n));
  for (const name of authorBranches) {
    if (allSelected) current.delete(name);
    else current.add(name);
  }
  return current.size === allNames.length ? null : [...current];
}
