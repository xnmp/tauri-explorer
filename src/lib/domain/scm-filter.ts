/**
 * Fuzzy filter for the SCM sidebar's pending/changed file list (#517).
 *
 * Pure and framework-free so the narrowing rules are unit-testable without a
 * component harness — ScmSidebarView.svelte only owns the query string and the
 * input element. Matching reuses the app-wide `fuzzyScorePath` scorer (the one
 * Quick Open uses) so a query behaves the same here as everywhere else.
 */

import type { GitFileEntry } from "$lib/domain/git";
import { fuzzyScorePath } from "$lib/domain/fuzzy-score";

/** The four file sections an SCM status summary exposes. */
export interface ScmSections {
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  untracked: GitFileEntry[];
  merge: GitFileEntry[];
}

/** Whether a query actually narrows anything (blank/whitespace does not). */
export function isScmFilterActive(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * Narrow repo-relative entries to those fuzzy-matching `query`, best match
 * first. A blank/whitespace-only query is "no filter" and returns the input
 * untouched.
 *
 * `fuzzyScorePath` returns 0 for a non-match, so `> 0` is the match test; it
 * weights basename hits above directory hits, which is what a file sidebar
 * wants. Ties keep their incoming order (Array#sort is stable), so the git
 * ordering within a section survives wherever scores are equal.
 */
export function filterScmEntries<T extends { path: string }>(entries: T[], query: string): T[] {
  if (!isScmFilterActive(query)) return entries;
  const q = query.trim();
  return entries
    .map((entry) => ({ entry, score: fuzzyScorePath(q, entry.path) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
}

/** Which empty-list message the sidebar owes the user, if any. */
export type ScmEmptyState = "none" | "clean" | "no-match";

/**
 * Decide the sidebar's empty state from the row counts either side of the
 * filter. `pendingBeforeFilter` is the dir-scoped pending count, i.e. what the
 * panel would show with no query.
 */
export function scmEmptyState(
  pendingBeforeFilter: number,
  visibleAfterFilter: number,
  query: string,
): ScmEmptyState {
  if (visibleAfterFilter > 0) return "none";
  // Only call it a filter miss if the filter is what emptied the list. A
  // query can outlive the rows it was written for — the pane moves into a
  // folder with no changes, or the tree goes clean under the watcher — and
  // reporting "no files match" there misdescribes a clean tree.
  return isScmFilterActive(query) && pendingBeforeFilter > 0 ? "no-match" : "clean";
}

/**
 * Whether the filter input should be rendered at all. Nothing to filter and
 * no query means no input; but a live query always keeps its input, otherwise
 * the query survives with no way to see or clear it.
 */
export function showScmFilterInput(pendingBeforeFilter: number, query: string): boolean {
  return pendingBeforeFilter > 0 || isScmFilterActive(query);
}

/** Apply {@link filterScmEntries} to every section of a status summary. */
export function filterScmSummary<S extends ScmSections>(summary: S, query: string): S {
  if (!isScmFilterActive(query)) return summary;
  // Spread-with-overrides: the four section arrays are replaced, every other
  // field (is_repo, branch, op_state, …) is carried through unchanged.
  return {
    ...summary,
    staged: filterScmEntries(summary.staged, query),
    changes: filterScmEntries(summary.changes, query),
    untracked: filterScmEntries(summary.untracked, query),
    merge: filterScmEntries(summary.merge, query),
  };
}
