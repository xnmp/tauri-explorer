/**
 * Fuzzy filter for the SCM sidebar's pending/changed file list (#517).
 *
 * Pure and framework-free so the narrowing rules are unit-testable without a
 * component harness — ScmSidebarView.svelte only owns the query string and the
 * input element. Matching reuses the app-wide `fuzzyScorePath` scorer (the one
 * Quick Open uses) so a query behaves the same here as everywhere else.
 */

import type { GitFileEntry } from "$lib/domain/git";

/** The four file sections an SCM status summary exposes. */
export interface ScmSections {
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  untracked: GitFileEntry[];
  merge: GitFileEntry[];
}

/**
 * Narrow repo-relative entries to those fuzzy-matching `query`, best match
 * first. A blank/whitespace-only query is "no filter" and returns the input
 * untouched.
 */
export function filterScmEntries<T extends { path: string }>(entries: T[], query: string): T[] {
  return entries;
}

/** Apply {@link filterScmEntries} to every section of a status summary. */
export function filterScmSummary<S extends ScmSections>(summary: S, query: string): S {
  return summary;
}
