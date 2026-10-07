import type { SearchResult } from "./search";
import { basename, directoryKey, parentDir } from "./path";
import { fuzzyScorePath } from "./fuzzy-score";
import { matchesPickerExtensions } from "./file-picker";
import { QUICK_OPEN_RESULT_LIMIT } from "./quick-open-search";

export interface PickerHistoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  timestamp: number;
}

/** Rank local history and backend matches once, deduplicate paths and bound rendering. */
export function rankPickerResults({ query, recent, directories, scores, remote = [], directoriesOnly, extensions, now = Date.now() }: {
  query: string;
  recent: readonly PickerHistoryEntry[];
  directories: readonly { path: string; dismissedFromRecent?: boolean }[];
  scores: ReadonlyMap<string, number>;
  remote?: readonly SearchResult[];
  directoriesOnly: boolean;
  extensions?: readonly string[];
  now?: number;
}): SearchResult[] {
  const q = query.trim();
  const candidates = new Map<string, SearchResult>();
  function add(entry: { name: string; path: string; kind: "file" | "directory" }, timestamp = 0, backendScore = 0) {
    if (!entry || typeof entry.path !== "string" || typeof entry.name !== "string" || !["file", "directory"].includes(entry.kind)) return;
    if ((directoriesOnly && entry.kind !== "directory") || !matchesPickerExtensions(entry, extensions)) return;
    const fuzzy = q ? fuzzyScorePath(q, entry.path) : 0;
    if (q && fuzzy <= 0) return;
    const key = directoryKey(entry.path);
    const historyScore = scores.get(directoryKey(entry.kind === "directory" ? entry.path : parentDir(entry.path))) ?? 0;
    const recency = Number.isFinite(timestamp) && timestamp > 0 ? 10 / (1 + Math.max(0, now - timestamp) / 3_600_000) : 0;
    const result: SearchResult = { ...entry, relativePath: entry.path, score: Math.max(fuzzy * 5, backendScore) + historyScore * 20 + recency };
    if (!candidates.has(key) || candidates.get(key)!.score < result.score) candidates.set(key, result);
  }
  for (const entry of Array.isArray(recent) ? recent : []) add(entry, entry?.timestamp);
  for (const entry of Array.isArray(directories) ? directories : []) {
    if (entry && typeof entry.path === "string" && !entry.dismissedFromRecent) add({ name: basename(entry.path), path: entry.path, kind: "directory" });
  }
  for (const entry of remote) add(entry, 0, entry.score);
  return [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, QUICK_OPEN_RESULT_LIMIT);
}
