/** Complete directory snapshots reconcile with mutations committed during the
 * read. Presentation filtering never changes filesystem membership. */
import type { FileEntry } from "./file";

function sameEntry(a: FileEntry, b: FileEntry): boolean {
  return a === b || (a.path === b.path && a.name === b.name && a.kind === b.kind
    && a.size === b.size && a.modified === b.modified
    && a.is_symlink === b.is_symlink && a.symlink_target === b.symlink_target
    && a.is_empty === b.is_empty && a.is_git_repo === b.is_git_repo);
}

function sameEntries(a: readonly FileEntry[], b: readonly FileEntry[]): boolean {
  return a === b || (a.length === b.length && a.every((entry, index) => sameEntry(entry, b[index])));
}

export function reconcileDirectoryEntries(
  before: FileEntry[], current: FileEntry[], incoming: FileEntry[],
): { entries: FileEntry[]; needsRefresh: boolean } {
  if (sameEntries(before, current)) {
    return { entries: sameEntries(current, incoming) ? current : incoming, needsRefresh: false };
  }
  const previous = new Map<string, FileEntry>();
  const remaining = new Map<string, FileEntry>();
  for (const entry of before) previous.set(entry.path, entry);
  for (const entry of current) remaining.set(entry.path, entry);
  const entries: FileEntry[] = [];
  let needsRefresh = false;
  for (const observed of incoming) {
    const prior = previous.get(observed.path);
    const local = remaining.get(observed.path);
    remaining.delete(observed.path);
    if (prior && !local) {
      // A completed local deletion/rename must not be resurrected by this read.
      needsRefresh = true;
    } else if (local && (!prior || !sameEntry(local, prior))) {
      entries.push(local);
      needsRefresh ||= !sameEntry(local, observed);
    } else {
      entries.push(observed);
    }
  }
  for (const local of remaining.values()) {
    const prior = previous.get(local.path);
    if (!prior || !sameEntry(local, prior)) {
      entries.push(local);
      needsRefresh = true;
    }
  }
  // A fresh read after the overlap establishes ordering against external work.
  // The existing refresh scheduler owns that follow-up; this policy never polls.
  return { entries: sameEntries(current, entries) ? current : entries, needsRefresh };
}

export interface DirectorySelection {
  selectedPaths: ReadonlySet<string>;
  cursorPath: string | null;
  anchorPath: string | null;
}

export function reconcileDirectorySelection(
  entries: readonly FileEntry[], current: DirectorySelection, before: DirectorySelection = current,
): DirectorySelection & { needsRefresh: boolean } {
  const { selectedPaths, cursorPath, anchorPath } = current;
  if (!selectedPaths.size && cursorPath === null && anchorPath === null) {
    return { ...current, needsRefresh: false };
  }
  const missing = new Set(selectedPaths);
  let cursorPresent = cursorPath === null;
  let anchorPresent = anchorPath === null;
  for (const entry of entries) {
    missing.delete(entry.path);
    cursorPresent ||= entry.path === cursorPath;
    anchorPresent ||= entry.path === anchorPath;
    if (!missing.size && cursorPresent && anchorPresent) break;
  }
  // A committed mutation may supply no presentation metadata. Its newly
  // assigned identity still needs a read started AFTER that publication.
  let needsRefresh = false;
  for (const path of missing) {
    if (!before.selectedPaths.has(path)) {
      missing.delete(path);
      needsRefresh = true;
    }
  }
  const keepNewCursor = !cursorPresent && cursorPath !== before.cursorPath;
  const keepNewAnchor = !anchorPresent && anchorPath !== before.anchorPath;
  return {
    selectedPaths: missing.size ? new Set([...selectedPaths].filter((path) => !missing.has(path))) : selectedPaths,
    cursorPath: cursorPresent || keepNewCursor ? cursorPath : null,
    anchorPath: anchorPresent || keepNewAnchor ? anchorPath : null,
    needsRefresh: needsRefresh || keepNewCursor || keepNewAnchor,
  };
}
