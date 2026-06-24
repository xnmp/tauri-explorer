/**
 * Recent files state management using Svelte 5 runes.
 * Issue: tauri-explorer-kwe, tauri-explorer-omkn
 *
 * Tracks recently opened/navigated files and directories.
 * Persisted to localStorage with a max capacity.
 */

import { checkPathsExist } from "$lib/api/files";
import { directoryKey } from "$lib/domain/path";
import { loadPersisted, savePersisted } from "./persisted";

export interface RecentEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  timestamp: number;
}

const STORAGE_KEY = "explorer-recent-files";
const MAX_ENTRIES = 50;

function createRecentFilesState() {
  let entries = $state<RecentEntry[]>(loadPersisted(STORAGE_KEY, []));

  function save() {
    savePersisted(STORAGE_KEY, entries);
  }

  function add(path: string, name: string, kind: "file" | "directory") {
    // Remove existing entry for this path (will be re-added at top). Compare by
    // canonical key so separator/case variants of the same path don't duplicate.
    const key = directoryKey(path);
    const filtered = entries.filter((e) => directoryKey(e.path) !== key);
    entries = [
      { name, path, kind, timestamp: Date.now() },
      ...filtered,
    ].slice(0, MAX_ENTRIES);
    save();
  }

  function remove(path: string) {
    const key = directoryKey(path);
    entries = entries.filter((e) => directoryKey(e.path) !== key);
    save();
  }

  function clear() {
    entries = [];
    save();
  }

  /** Remove entries whose paths no longer exist on disk. */
  async function pruneNonExistent(): Promise<void> {
    if (entries.length === 0) return;
    const paths = entries.map((e) => e.path);
    const exists = await checkPathsExist(paths);
    // `entries` may have changed while awaiting (e.g. add) — filter by path
    // membership against the snapshot, not by index into a stale array.
    const missing = new Set(paths.filter((_, i) => !exists[i]));
    if (missing.size === 0) return;
    entries = entries.filter((e) => !missing.has(e.path));
    save();
  }

  return {
    get list() { return entries; },
    get count() { return entries.length; },
    add,
    remove,
    clear,
    pruneNonExistent,
  };
}

export const recentFilesStore = createRecentFilesState();
