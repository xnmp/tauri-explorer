/**
 * SCM tree grouping: folds a flat list of repo-relative file entries into a
 * folder tree for the SCM panel's tree view. Pure — extracted from
 * ScmSidebarView.svelte so it can be unit tested.
 */

import type { GitFileEntry } from "$lib/domain/git";
import { directoryKey } from "$lib/domain/path";

/** Tree node used by the folder-grouped SCM rendering. */
export interface ScmTreeNode {
  name: string;
  /** Repo-relative directory path; empty string for the root node. */
  fullDir: string;
  children: Map<string, ScmTreeNode>;
  files: GitFileEntry[];
}

/** Group flat repo-relative entries into a folder tree. */
export function buildTree(rows: GitFileEntry[]): ScmTreeNode {
  const root: ScmTreeNode = { name: "", fullDir: "", children: new Map(), files: [] };
  for (const row of rows) {
    const parts = row.path.split("/").filter((p) => p !== "");
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      let next = cursor.children.get(segment);
      if (!next) {
        next = {
          name: segment,
          fullDir: cursor.fullDir ? `${cursor.fullDir}/${segment}` : segment,
          children: new Map(),
          files: [],
        };
        cursor.children.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(row);
  }
  return root;
}

/** All file paths under a node (depth-first), e.g. for folder-level actions. */
export function collectPaths(node: ScmTreeNode): string[] {
  const paths: string[] = node.files.map((f) => f.path);
  for (const child of node.children.values()) {
    paths.push(...collectPaths(child));
  }
  return paths;
}

/**
 * Restrict repo-relative entries to those under `activePath` (#380).
 *
 * Pure and separator/case tolerant: on Windows the pane path uses
 * backslashes ("C:\Users\me\proj\sub") while git2 reports the repo root
 * with forward slashes ("C:/Users/me/proj") — a raw string prefix check
 * matched nothing, so the git panel showed "no changes" for every repo.
 * Both sides are normalized through `directoryKey` before comparing.
 */
export function filterEntriesToDir<T extends { path: string }>(
  entries: T[],
  repoRoot: string | null,
  activePath: string,
): T[] {
  if (!activePath || !repoRoot) return entries;
  const active = directoryKey(activePath);
  const root = directoryKey(repoRoot);
  if (active === root) return entries;
  const prefix = active + "/";
  return entries.filter((e) => directoryKey(root + "/" + e.path).startsWith(prefix));
}
