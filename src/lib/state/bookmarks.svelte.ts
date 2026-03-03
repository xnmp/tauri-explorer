/**
 * Bookmarks state management using Svelte 5 runes.
 * Issue: tauri-explorer-sm3p, tauri-ti0l
 *
 * Stores user-pinned folders that appear in the sidebar Quick Access section.
 * Persisted to a config file (~/.config/tauri-explorer/bookmarks.json) with
 * localStorage as synchronous fallback for immediate state.
 */

import { loadPersisted, savePersisted } from "./persisted";
import { readConfigFile, writeConfigFile } from "$lib/api/files";

export interface Bookmark {
  name: string;
  path: string;
  icon: "folder" | "custom";
  color?: string;
}

const STORAGE_KEY = "explorer-bookmarks";
const CONFIG_FILENAME = "bookmarks.json";

function createBookmarksState() {
  let bookmarks = $state<Bookmark[]>(loadPersisted(STORAGE_KEY, []));

  function save() {
    // Write-through: save to both localStorage (sync) and config file (async)
    savePersisted(STORAGE_KEY, bookmarks);
    writeConfigFile(CONFIG_FILENAME, JSON.stringify(bookmarks, null, 2)).catch((err) => {
      console.warn("Failed to save bookmarks to config file:", err);
    });
  }

  /**
   * Load bookmarks from config file, migrating from localStorage if needed.
   * Called once during app initialization.
   */
  async function init() {
    try {
      const result = await readConfigFile(CONFIG_FILENAME);
      if (result.ok && result.data) {
        const loaded = JSON.parse(result.data) as Bookmark[];
        if (Array.isArray(loaded) && loaded.length > 0) {
          bookmarks = loaded;
          savePersisted(STORAGE_KEY, bookmarks);
          return;
        }
      }
    } catch {
      // Config file doesn't exist or is invalid - fall through
    }

    // If config file was empty but localStorage has data, migrate
    if (bookmarks.length > 0) {
      writeConfigFile(CONFIG_FILENAME, JSON.stringify(bookmarks, null, 2)).catch(() => {});
    }
  }

  function addBookmark(path: string, name?: string) {
    // Don't add duplicates
    if (bookmarks.some((b) => b.path === path)) {
      return false;
    }

    // Extract folder name from path if not provided
    const folderName = name || path.split("/").filter(Boolean).pop() || path;

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
    addBookmark,
    removeBookmark,
    hasBookmark,
    reorderBookmarks,
  };
}

export const bookmarksStore = createBookmarksState();
