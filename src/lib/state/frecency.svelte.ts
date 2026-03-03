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

function createFrecencyStore() {
  let data = $state<FrecencyData>(loadPersisted(STORAGE_KEY, []));

  function save(): void {
    savePersisted(STORAGE_KEY, data);
  }

  /** Record an access to a path. */
  function recordAccess(path: string): void {
    const now = Date.now();
    const existing = data.find((e) => e.path === path);

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

  /** Get the frecency score for a path. Returns 0 if not tracked. */
  function getScore(path: string): number {
    const entry = data.find((e) => e.path === path);
    if (!entry) return 0;
    return computeFrecencyScore(entry.accesses, Date.now());
  }

  /** Get all scores as a Map for efficient batch lookups. */
  function getScoreMap(): Map<string, number> {
    const now = Date.now();
    const map = new Map<string, number>();
    for (const entry of data) {
      map.set(entry.path, computeFrecencyScore(entry.accesses, now));
    }
    return map;
  }

  /** Remove a path from tracking. */
  function remove(path: string): void {
    data = data.filter((e) => e.path !== path);
    save();
  }

  function clear(): void {
    data = [];
    save();
  }

  return {
    get entries() { return data; },
    recordAccess,
    getScore,
    getScoreMap,
    remove,
    clear,
  };
}

export const frecencyStore = createFrecencyStore();
