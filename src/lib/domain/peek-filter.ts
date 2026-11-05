/**
 * Pane filter inside Folder Peek (#1510): a folder whose own name does not
 * match stays visible while something matching lies a bounded number of
 * levels beneath it, and every peek level shows only matches plus the folders
 * on the path to one. Pure: listings arrive through a lookup, already reduced
 * to the entries the pane shows (hidden rules applied).
 */
import type { FileEntry } from "./file";

/** Levels below a top-level folder searched for a match. The bound is
 * measured from the pane's own listing: a folder N levels down that bound
 * keeps only a budget of `PEEK_FILTER_MAX_DEPTH - N` for its own descendants. */
export const PEEK_FILTER_MAX_DEPTH = 3;
/** Directory listings one filter session may request beneath the pane. */
export const PEEK_FILTER_MAX_DIRECTORIES = 2_000;
/** Entries those listings may hold in total before the scan stops. */
export const PEEK_FILTER_MAX_ENTRIES = 50_000;

export type PeekFilterListing = (path: string) => readonly FileEntry[] | undefined;

/**
 * Directories with a matching descendant within their remaining depth budget.
 * A top-level folder (an entry of `entries`) may reach `maxDepth` levels
 * below itself; each nested folder one level fewer. Folders whose listing is
 * unknown (not yet scanned, or past the scan's caps) prove nothing and are
 * not kept. A name-matching folder is shown anyway; its kept subfolders are
 * included so its peek shows the paths to deeper matches.
 */
export function peekFilterKeeps(options: {
  entries: readonly FileEntry[];
  listing: PeekFilterListing;
  matches: (entry: FileEntry) => boolean;
  maxDepth?: number;
}): Set<string> {
  const { listing, matches } = options;
  const keeps = new Set<string>();
  const visited = new Set<string>();
  /** Whether a match lies at most `budget` levels below `dir`; marks every
   * folder on the way to one. */
  const reaches = (dir: string, budget: number): boolean => {
    if (budget <= 0 || visited.has(dir)) return false;
    const children = listing(dir);
    if (!children) return false;
    visited.add(dir);
    let found = false;
    for (const child of children) {
      if (matches(child)) found = true;
      if (child.kind === "directory" && reaches(child.path, budget - 1)) {
        keeps.add(child.path);
        found = true;
      }
    }
    return found;
  };
  const depth = options.maxDepth ?? PEEK_FILTER_MAX_DEPTH;
  for (const entry of options.entries) {
    if (entry.kind === "directory" && reaches(entry.path, depth)) keeps.add(entry.path);
  }
  return keeps;
}

/** Whether a folder at `level` (1 = the pane's own listing) needs its listing
 * for the filter's descendant search. */
export function scanReaches(level: number, maxDepth = PEEK_FILTER_MAX_DEPTH): boolean {
  return level >= 1 && level <= maxDepth;
}
