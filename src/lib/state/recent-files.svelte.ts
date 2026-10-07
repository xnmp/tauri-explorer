/**
 * Recent files state management using Svelte 5 runes.
 * Issue: tauri-explorer-kwe, tauri-explorer-omkn
 *
 * Tracks recently opened/navigated files and directories.
 * Persisted to localStorage with a max capacity.
 */

import { sanitizeRecentHistory, type HistoryRecentEntry } from "$lib/domain/history";
import { enqueueHistory, registerRecentHistory } from "./shared-history";
import { checkPathsExist } from "$lib/api/files";
import { directoryKey } from "$lib/domain/path";
import { loadPersisted, savePersisted } from "./persisted";

export type RecentEntry = HistoryRecentEntry;

const STORAGE_KEY = "explorer-recent-files";
const MAX_ENTRIES = 50;

function createRecentFilesState() {
  let entries = $state<RecentEntry[]>(sanitizeRecentHistory(loadPersisted(STORAGE_KEY, [], 1_000_000)));

  function save() {
    savePersisted(STORAGE_KEY, entries);
  }

  function refresh(): void {
    entries = sanitizeRecentHistory(loadPersisted(STORAGE_KEY, entries, 1_000_000));
  }

  function add(path: string, name: string, kind: "file" | "directory") {
    refresh();
    const timestamp = Date.now();
    enqueueHistory({ type: "recent", key: directoryKey(path), entry: { name, path, kind, timestamp } });
    // Remove existing entry for this path (will be re-added at top). Compare by
    // canonical key so separator/case variants of the same path don't duplicate.
    const key = directoryKey(path);
    const filtered = entries.filter((e) => directoryKey(e.path) !== key);
    entries = [
      { name, path, kind, timestamp },
      ...filtered,
    ].slice(0, MAX_ENTRIES);
    save();
  }

  function remove(path: string) {
    enqueueHistory({ type: "remove", collection: "recent", keys: [directoryKey(path)] });
    const key = directoryKey(path);
    entries = entries.filter((e) => directoryKey(e.path) !== key);
    save();
  }

  function clear() {
    enqueueHistory({ type: "clear", collection: "recent" });
    entries = [];
    save();
  }

  /** Remove entries whose paths no longer exist on disk. */
  async function pruneNonExistent(): Promise<void> {
    if (entries.length === 0) return;
    const inspected = entries;
    const paths = inspected.map((e) => e.path);
    const exists = await checkPathsExist(paths);
    // `entries` may have changed while awaiting (e.g. add) — filter by path
    // membership against the snapshot, not by index into a stale array.
    const missing = new Set(paths.filter((_, i) => !exists[i]));
    if (missing.size === 0) return;
    enqueueHistory({ type: "prune", collection: "recent", entries: inspected.filter(entry => missing.has(entry.path)).map(entry => ({ key: directoryKey(entry.path), revision: entry.revision ?? 0 })) });
    const observed = new Map(inspected.map(entry => [directoryKey(entry.path), entry]));
    entries = entries.filter(entry => !missing.has(entry.path) || entry !== observed.get(directoryKey(entry.path)));
    save();
  }

  registerRecentHistory({ get: () => entries, set: value => { entries = value; save(); } });

  return {
    get list() { return entries; },
    get count() { return entries.length; },
    add,
    refresh,
    remove,
    clear,
    pruneNonExistent,
  };
}

export const recentFilesStore = createRecentFilesState();
