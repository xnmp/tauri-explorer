/**
 * Source Control sidebar presentation rules: status badges, row path split,
 * the visual row order keyboard navigation walks, and commit admission.
 * Pure — extracted from ScmSidebarView.svelte (#1372).
 */

import type { GitFileEntry, GitStatusCode } from "$lib/domain/git";
import { basename, parentDir } from "$lib/domain/path";
import { buildTree, type ScmTreeNode } from "$lib/domain/scm-tree";

export type ScmSectionKind = "staged" | "changes" | "untracked" | "merge";

/** Single-letter status badge. Exhaustive over `GitStatusCode`: unlike
 *  `gitStatusLetter`, an unknown code renders no letter rather than "?". */
export function statusLetter(code: GitStatusCode): string {
  switch (code) {
    case "Modified": return "M";
    case "Added": return "A";
    case "Deleted": return "D";
    case "Renamed": return "R";
    case "Copied": return "C";
    case "Untracked": return "U";
    case "Ignored": return "I";
    case "Conflicted": return "!";
    case "TypeChange": return "T";
  }
}

/** Badge colour class; untracked files read as additions. */
export function statusClass(code: GitStatusCode): string {
  switch (code) {
    case "Modified": return "s-modified";
    case "Added":
    case "Untracked": return "s-added";
    case "Deleted": return "s-deleted";
    case "Renamed":
    case "Copied": return "s-renamed";
    case "Conflicted": return "s-conflict";
    case "Ignored": return "s-ignored";
    case "TypeChange": return "s-type";
  }
}

/** Flat-list row label: file name, plus its directory when it has one. */
export function splitScmPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", name: path };
  return { dir: parentDir(path), name: basename(path) };
}

/** File paths in visual tree order: subfolders first, then the folder's own
 *  files; collapsed subtrees are skipped. */
export function visibleTreePaths(rows: GitFileEntry[], collapsed: ReadonlySet<string>): string[] {
  function walk(node: ScmTreeNode): string[] {
    const out: string[] = [];
    for (const child of node.children.values()) {
      if (!collapsed.has(child.fullDir)) out.push(...walk(child));
    }
    out.push(...node.files.map((f) => f.path));
    return out;
  }
  return walk(buildTree(rows));
}

/** Row paths in the order the user sees them across sections, skipping
 *  collapsed sections (and collapsed tree folders in tree view). */
export function visibleScmRowPaths(
  sections: readonly { rows: GitFileEntry[]; expanded: boolean }[],
  treeView: boolean,
  collapsed: ReadonlySet<string>,
): string[] {
  const paths: string[] = [];
  for (const { rows, expanded } of sections) {
    if (!expanded) continue;
    paths.push(...(treeView ? visibleTreePaths(rows, collapsed) : rows.map((r) => r.path)));
  }
  return paths;
}

/** The row an Up/Down step selects: from no (or a vanished) selection, Down
 *  starts at the first row and Up at the last; otherwise clamp at the ends. */
export function nextScmSelection(rows: readonly string[], selected: string | null, delta: 1 | -1): string | undefined {
  if (rows.length === 0) return undefined;
  const currentIdx = selected == null ? -1 : rows.indexOf(selected);
  const next = currentIdx < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.max(0, Math.min(rows.length - 1, currentIdx + delta));
  return rows[next];
}

/** Whether Commit is enabled. Counts are repo-wide (commits ignore the
 *  sidebar filter); unresolved conflicts block every commit, mirroring git's
 *  own refusal while the index is unmerged. Amend needs no new message. */
export function canCommitScm(input: {
  isRepo: boolean;
  conflicted: number;
  staged: number;
  message: string;
  amend: boolean;
}): boolean {
  if (!input.isRepo) return false;
  if (input.conflicted > 0) return false;
  if (input.amend) return true;
  return input.message.trim().length > 0 && input.staged > 0;
}
