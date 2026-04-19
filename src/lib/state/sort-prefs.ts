/**
 * Per-directory sort preference persistence.
 * Extracted from explorer.svelte.ts.
 */

import { loadPersisted, savePersisted } from "./persisted";
import type { SortField } from "$lib/domain/file";

const SORT_STORAGE_KEY = "explorer-sort-prefs";
const MAX_SORT_ENTRIES = 200;

export interface SortPref {
  sortBy: SortField;
  sortAscending: boolean;
}

function loadSortPrefs(): Record<string, SortPref> {
  return loadPersisted(SORT_STORAGE_KEY, {});
}

export function saveSortPref(path: string, pref: SortPref): void {
  const prefs = loadSortPrefs();
  prefs[path] = pref;
  const keys = Object.keys(prefs);
  if (keys.length > MAX_SORT_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_SORT_ENTRIES)) {
      delete prefs[key];
    }
  }
  savePersisted(SORT_STORAGE_KEY, prefs);
}

export function getSortPref(path: string): SortPref | undefined {
  return loadSortPrefs()[path];
}
