/**
 * Frecency (frequency + recency) store for zoxide-style path ranking.
 * Issue: tauri-jrek
 *
 * Each path access is recorded with a timestamp. The frecency score
 * is computed as the sum of recency-weighted access events, following
 * the zoxide algorithm: score = sum(1 / (hours_since_access + 1)).
 *
 * This means recent accesses contribute ~1.0, accesses from an hour ago
 * contribute ~0.5, from a day ago ~0.04, etc.
 */

import { checkPathsExist } from "$lib/api/files";
import { directoryKey, parentDir } from "$lib/domain/path";
import { loadPersisted, savePersisted } from "./persisted";

const STORAGE_KEY = "explorer-frecency";
const MAX_ENTRIES = 200;
const MAX_ACCESSES_PER_ENTRY = 10;
const MS_PER_HOUR = 3_600_000;

export interface FrecencyEntry {
  path: string;
  accesses: number[]; // timestamps of recent accesses
}

export type FrecencyData = FrecencyEntry[];

/** Compute the frecency score for a single entry at the given time. */
export function computeFrecencyScore(accesses: number[], now: number): number {
  let score = 0;
  for (const ts of accesses) {
    const hoursSince = Math.max(0, (now - ts) / MS_PER_HOUR);
    score += 1 / (hoursSince + 1);
  }
  return score;
}

/**
 * Soft-downvote an access history: forget roughly half the recorded accesses,
 * dropping the most recent (highest-weighted) ones so the frecency score falls
 * now. Pure — returns a new array, never mutates.
 *
 * This is deliberately NOT a blacklist: the entry keeps its older history, and
 * a fresh access (recorded at `now`) contributes ~1.0 and pushes the score back
 * up — so ranking recovers naturally if the path is used again. Dropping the
 * newest accesses maximises the immediate score drop while leaving a trail that
 * recovery can build on.
 *
 * A single-access entry collapses to `[]` (caller should drop the entry).
 */
export function penalizeAccesses(accesses: number[]): number[] {
  if (accesses.length <= 1) return [];
  const oldestFirst = [...accesses].sort((a, b) => a - b);
  const keep = Math.floor(oldestFirst.length / 2);
  return oldestFirst.slice(0, keep); // keep the oldest half, drop the recent (heavy) accesses
}

function createFrecencyStore() {
  let data = $state<FrecencyData>(loadPersisted(STORAGE_KEY, []));

  function save(): void {
    savePersisted(STORAGE_KEY, data);
  }

  /** Record an access to a path. */
  function recordAccess(path: string): void {
    const now = Date.now();
    const key = directoryKey(path);
    const existing = data.find((e) => directoryKey(e.path) === key);

    if (existing) {
      existing.accesses = [...existing.accesses.slice(-(MAX_ACCESSES_PER_ENTRY - 1)), now];
    } else {
      data = [...data, { path, accesses: [now] }];
    }

    // Prune old entries if over capacity (remove lowest-scoring)
    if (data.length > MAX_ENTRIES) {
      const scored = data.map((e) => ({
        entry: e,
        score: computeFrecencyScore(e.accesses, now),
      }));
      scored.sort((a, b) => b.score - a.score);
      data = scored.slice(0, MAX_ENTRIES).map((s) => s.entry);
    }

    save();
  }

  /**
   * Record that a *file* was acted on (opened, previewed, set as wallpaper,
   * moved, renamed, …). The frecency entry is the file's containing folder, so
   * the Recent locations list ranks folders by where the user actually works
   * with files — not by mere browse-navigation through them.
   */
  function recordFileAction(filePath: string): void {
    recordAccess(parentDir(filePath));
  }

  /** Get the frecency score for a path. Returns 0 if not tracked. */
  function getScore(path: string): number {
    const key = directoryKey(path);
    const entry = data.find((e) => directoryKey(e.path) === key);
    if (!entry) return 0;
    return computeFrecencyScore(entry.accesses, Date.now());
  }

  /**
   * Get all scores as a Map for efficient batch lookups. Keyed by
   * `directoryKey(path)` — look up with `directoryKey(somePath)`, not the raw
   * path, so separator/case variants resolve to the same entry.
   */
  function getScoreMap(): Map<string, number> {
    const now = Date.now();
    const map = new Map<string, number>();
    for (const entry of data) {
      map.set(directoryKey(entry.path), computeFrecencyScore(entry.accesses, now));
    }
    return map;
  }

  /**
   * Downvote a path: reduce its recorded access count as if roughly half of its
   * accesses were forgotten (see {@link penalizeAccesses}). The score drops now
   * but recovers when the path is accessed again — this is not a blacklist. If
   * the entry has no accesses left afterwards it is removed entirely.
   */
  function penalize(path: string): void {
    const key = directoryKey(path);
    const idx = data.findIndex((e) => directoryKey(e.path) === key);
    if (idx === -1) return;
    const reduced = penalizeAccesses(data[idx].accesses);
    if (reduced.length === 0) {
      data = data.filter((_, i) => i !== idx);
    } else {
      data = data.map((e, i) => (i === idx ? { ...e, accesses: reduced } : e));
    }
    save();
  }

  /** Remove a path from tracking. */
  function remove(path: string): void {
    const key = directoryKey(path);
    data = data.filter((e) => directoryKey(e.path) !== key);
    save();
  }

  function clear(): void {
    data = [];
    save();
  }

  /** Remove entries whose paths no longer exist on disk. */
  async function pruneNonExistent(): Promise<void> {
    if (data.length === 0) return;
    const paths = data.map((e) => e.path);
    const exists = await checkPathsExist(paths);
    // `data` may have changed while awaiting (e.g. recordAccess) — filter by
    // path membership against the snapshot, not by index into a stale array.
    const missing = new Set(paths.filter((_, i) => !exists[i]));
    if (missing.size === 0) return;
    data = data.filter((e) => !missing.has(e.path));
    save();
  }

  return {
    get entries() { return data; },
    recordAccess,
    recordFileAction,
    getScore,
    getScoreMap,
    penalize,
    remove,
    clear,
    pruneNonExistent,
  };
}

export const frecencyStore = createFrecencyStore();
