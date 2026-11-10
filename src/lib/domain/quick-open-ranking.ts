/**
 * Quick Open ranking: pure scoring, local matching and the bounded merge.
 *
 * Every function here is a pure transform of its inputs. The session
 * (`state/quick-open-session.svelte.ts`) decides WHEN to rank; the component
 * supplies the store snapshots (recents, frecency, active-pane entries).
 */
import { filenameMatchScore, fuzzyScorePath } from "./fuzzy-score";
import { basename, directoryKey, toForwardSlashes } from "./path";
import type { SearchResult } from "./search";
import { TRASH_PATH, isTrashRoot } from "./trash";
import { QUICK_OPEN_RESULT_LIMIT } from "./quick-open-search";

/** Frecency weight relative to fuzzy score (how much frecency influences ranking). */
export const FRECENCY_WEIGHT = 50;
/** Directories get a score boost since they're more commonly navigated to. */
export const DIRECTORY_BONUS = 1.25;

/** Frecency scores keyed by `directoryKey(path)`. */
export type FrecencyScoreMap = ReadonlyMap<string, number>;

export interface QuickOpenRecentEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface QuickOpenPaneEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: string;
}

/** Store snapshots the local (non-backend) matchers read. */
export interface QuickOpenLocalSources {
  readonly recents: readonly QuickOpenRecentEntry[];
  readonly frecencyPaths: readonly { readonly path: string }[];
  readonly scoreMap: FrecencyScoreMap;
  /** The active pane's own loaded entries; empty when there is no active explorer. */
  readonly paneEntries: readonly QuickOpenPaneEntry[];
}

/** Integer ranking points contributed by a frecency score. */
export function frecencyPoints(frecency: number): number {
  return Math.round(frecency * FRECENCY_WEIGHT);
}

/** Effective score with the directory bonus applied. */
export function effectiveScore(result: SearchResult): number {
  return result.kind === "directory" ? result.score * DIRECTORY_BONUS : result.score;
}

function byEffectiveScoreDescending(a: SearchResult, b: SearchResult): number {
  return effectiveScore(b) - effectiveScore(a);
}

/** The Recycle Bin is only offered once the user has actually worked in it. */
function hiddenTrashRoot(path: string, scoreMap: FrecencyScoreMap): boolean {
  return isTrashRoot(path) && (scoreMap.get(directoryKey(TRASH_PATH)) ?? 0) <= 0;
}

/**
 * Match recent files and frecency entries against a search term. These are
 * always merged (deduplicated) with backend results. A path seen in recents
 * is not matched again from frecency, even when the recent entry missed.
 */
export function matchHistoryEntries(
  term: string,
  recents: readonly QuickOpenRecentEntry[],
  frecencyPaths: readonly { readonly path: string }[],
  scoreMap: FrecencyScoreMap,
): SearchResult[] {
  const lower = term.toLowerCase();
  const seen = new Set<string>();
  const matched: SearchResult[] = [];

  // Recent files — scored with full fuzzy matching.
  for (const entry of recents) {
    if (hiddenTrashRoot(entry.path, scoreMap)) continue;
    const key = directoryKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const fuzzy = fuzzyScorePath(lower, isTrashRoot(entry.path) ? "Recycle Bin Trash" : entry.path);
    if (fuzzy > 0) {
      matched.push({
        name: entry.name,
        path: entry.path,
        relativePath: entry.path,
        score: Math.round(fuzzy * 5) + filenameMatchScore(entry.name, lower) + frecencyPoints(scoreMap.get(key) ?? 0),
        kind: entry.kind,
      });
    }
  }

  // Frecency entries (mostly directories the user has worked in).
  for (const entry of frecencyPaths) {
    if (hiddenTrashRoot(entry.path, scoreMap)) continue;
    const key = directoryKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = isTrashRoot(entry.path) ? "Recycle Bin" : basename(entry.path);
    const fuzzy = fuzzyScorePath(lower, isTrashRoot(entry.path) ? `${name} Trash` : entry.path);
    if (fuzzy > 0) {
      matched.push({
        name,
        path: entry.path,
        relativePath: entry.path,
        score: Math.round(fuzzy * 5) + filenameMatchScore(name, lower) + frecencyPoints(scoreMap.get(key) ?? 0),
        kind: "directory",
      });
    }
  }

  return matched;
}

/**
 * Match the active pane's already-loaded entries against the term (#385).
 * The cwd's own files/folders must always be findable — and instantly —
 * independent of the backend walk (which missed cwd folders on Windows).
 */
export function matchPaneEntries(term: string, entries: readonly QuickOpenPaneEntry[]): SearchResult[] {
  const lower = term.toLowerCase();
  const matched: SearchResult[] = [];
  for (const entry of entries) {
    const nameBonus = filenameMatchScore(entry.name, lower);
    const fuzzy = fuzzyScorePath(lower, entry.name);
    if (fuzzy <= 0 && nameBonus <= 0) continue;
    matched.push({
      name: entry.name,
      path: entry.path,
      relativePath: entry.name,
      // Direct children of the cwd: score like a strong backend hit
      // (fuzzy × 5 mirrors the recents weighting) plus the name bonus.
      score: Math.round(fuzzy * 5) + nameBonus,
      kind: entry.kind === "directory" ? "directory" : "file",
    });
  }
  return matched;
}

/** Every local match for a term: recents/frecency first, then the active pane. */
export function localQuickOpenMatches(term: string, sources: QuickOpenLocalSources): SearchResult[] {
  return [
    ...matchHistoryEntries(term, sources.recents, sources.frecencyPaths, sources.scoreMap),
    ...matchPaneEntries(term, sources.paneEntries),
  ];
}

/** Re-rank backend hits by adding frecency and the filename bonus, best first. */
export function rankBackendResults(
  results: readonly SearchResult[],
  term: string,
  scoreMap: FrecencyScoreMap,
): SearchResult[] {
  const lower = term.toLowerCase();
  return results
    .map((r) => ({
      ...r,
      score: r.score + frecencyPoints(scoreMap.get(directoryKey(r.path)) ?? 0) + filenameMatchScore(r.name, lower),
    }))
    .sort(byEffectiveScoreDescending);
}

/**
 * Merge primary results with extras, best first, capped at `limit` rows.
 * Extras are deduped against the primary list AND among themselves — the same
 * path can arrive from recents, frecency, and the cwd listing (#385). The cap
 * keeps a broad query in a huge directory from rendering thousands of rows (#651).
 */
export function mergeResultsByScore(
  primary: readonly SearchResult[],
  extras: readonly SearchResult[],
  limit: number = QUICK_OPEN_RESULT_LIMIT,
): SearchResult[] {
  const seen = new Set(primary.map((r) => directoryKey(r.path)));
  const unique: SearchResult[] = [];
  for (const r of extras) {
    const key = directoryKey(r.path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  return [...primary, ...unique].sort(byEffectiveScoreDescending).slice(0, limit);
}

/**
 * The empty-query "Recent" list. A Recycle Bin entry is shown only once it
 * has frecency; `scoreOf` is consulted for trash roots only.
 */
export function recentQuickOpenResults(
  recents: readonly QuickOpenRecentEntry[],
  scoreOf: (path: string) => number,
): SearchResult[] {
  return recents
    .filter((entry) => !isTrashRoot(entry.path) || scoreOf(entry.path) > 0)
    .map((entry) => ({ name: entry.name, path: entry.path, relativePath: entry.path, score: 0, kind: entry.kind }));
}

/** Keep a selection index inside a list of `length` rows (0 for an empty list). */
export function clampSelection(index: number, length: number): number {
  return index >= length ? Math.max(0, length - 1) : index;
}

/**
 * Path shown in a result row: relative to the current folder when the file
 * lives under it (just the filename for a direct child), otherwise the full
 * path. Keeps cwd results compact instead of repeating the whole prefix.
 */
export function quickOpenDisplayPath(fullPath: string, cwdPath: string): string {
  const cwdKey = directoryKey(cwdPath);
  const fileKey = directoryKey(fullPath);
  if (cwdKey && cwdKey !== "/" && fileKey.startsWith(cwdKey + "/")) {
    // cwdKey only differs from the forward-slashed cwd by case folding, which
    // preserves length, so slicing the forward-slash form by its length
    // strips exactly the "cwd/" prefix while keeping the original casing.
    return toForwardSlashes(fullPath).slice(cwdKey.length + 1);
  }
  return fullPath;
}

export interface QuickOpenScoreBreakdown {
  /** Rounded effective score (directory bonus applied). */
  readonly effective: number;
  /** Backend/fuzzy points left after removing frecency and the name bonus. */
  readonly base: number;
  readonly name: number;
  readonly frecency: number;
  readonly directoryMultiplier: number;
}

/**
 * Debug (Alt+D) decomposition of a ranked result. `result.score` already has
 * frecency and the name bonus baked in, so the base score is derived by
 * subtracting them rather than double-counting.
 */
export function quickOpenScoreBreakdown(
  result: SearchResult,
  term: string,
  scoreMap: FrecencyScoreMap,
): QuickOpenScoreBreakdown {
  const name = filenameMatchScore(result.name, term.toLowerCase());
  const frecency = frecencyPoints(scoreMap.get(directoryKey(result.path)) ?? 0);
  return {
    effective: Math.round(effectiveScore(result)),
    base: Math.round(result.score - frecency - name),
    name,
    frecency,
    directoryMultiplier: result.kind === "directory" ? DIRECTORY_BONUS : 1,
  };
}
