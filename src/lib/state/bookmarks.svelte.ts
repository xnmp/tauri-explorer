/**
 * Bookmarks state management using Svelte 5 runes.
 * Issue: tauri-explorer-sm3p, tauri-ti0l
 *
 * Stores user-pinned folders that appear in the sidebar Quick Access section.
 * Persisted to a config file (~/.config/tauri-explorer/bookmarks.json) with
 * localStorage as synchronous fallback for immediate state.
 */

import { basename } from "$lib/domain/path";
import type { ConfigReloadReason } from "$lib/domain/config-reload";
import { createConfigDocument } from "./config-document";
import { loadPersisted } from "./persisted";

export interface Bookmark {
  name: string;
  path: string;
  icon: "folder" | "custom";
  color?: string;
}

const STORAGE_KEY = "explorer-bookmarks";
const CONFIG_FILENAME = "bookmarks.json";
const CONFIG_WRITER = "bookmarks-store";

function createBookmarksState() {
  let bookmarks = $state<Bookmark[]>(loadPersisted(STORAGE_KEY, []));

  const configDoc = createConfigDocument<Bookmark[]>({
    file: CONFIG_FILENAME,
    key: STORAGE_KEY,
    writer: CONFIG_WRITER,
    get: () => bookmarks,
    set: (next) => (bookmarks = next),
    // An empty file does not override the cache: it lets localStorage migrate.
    acceptOnInit: (parsed): parsed is Bookmark[] =>
      Array.isArray(parsed) && parsed.length > 0,
    acceptOnReload: (parsed): parsed is Bookmark[] => Array.isArray(parsed),
    // Migrates the live value (loaded from the cache at creation).
    migration: () => (bookmarks.length > 0 ? bookmarks : null),
  });

  /** Write-through: localStorage (sync) and config file (async). */
  const save = configDoc.save;

  /**
   * Load bookmarks from config file, migrating from localStorage if needed.
   * Called once during app initialization.
   */
  const init = configDoc.init;

  /** Re-read external bookmark edits without treating this store's writes as edits. */
  const reloadFromDisk: () => Promise<ConfigReloadReason> = configDoc.reload;

  function addBookmark(path: string, name?: string) {
    // Don't add duplicates
    if (bookmarks.some((b) => b.path === path)) {
      return false;
    }

    // Extract folder name from path if not provided
    const folderName = name || basename(path);

    bookmarks = [
      ...bookmarks,
      {
        name: folderName,
        path,
        icon: "folder",
      },
    ];
    save();
    return true;
  }

  function removeBookmark(path: string) {
    bookmarks = bookmarks.filter((b) => b.path !== path);
    save();
  }

  function hasBookmark(path: string): boolean {
    return bookmarks.some((b) => b.path === path);
  }

  function reorderBookmarks(fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || fromIndex >= bookmarks.length) return;
    if (toIndex < 0 || toIndex >= bookmarks.length) return;

    const newBookmarks = [...bookmarks];
    const [moved] = newBookmarks.splice(fromIndex, 1);
    newBookmarks.splice(toIndex, 0, moved);
    bookmarks = newBookmarks;
    save();
  }

  return {
    get list() {
      return bookmarks;
    },
    init,
    reloadFromDisk,
    addBookmark,
    removeBookmark,
    hasBookmark,
    reorderBookmarks,
  };
}

export const bookmarksStore = createBookmarksState();
