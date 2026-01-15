/**
 * Bookmarks state management using Svelte 5 runes.
 * Issue: tauri-explorer-sm3p
 *
 * Stores user-pinned folders that appear in the sidebar Quick Access section.
 * Bookmarks are persisted to localStorage.
 */

export interface Bookmark {
  name: string;
  path: string;
  icon: "folder" | "custom";
  color?: string;
}

const STORAGE_KEY = "explorer-bookmarks";

function createBookmarksState() {
  // Load saved bookmarks from localStorage
  const saved = typeof localStorage !== "undefined"
    ? localStorage.getItem(STORAGE_KEY)
    : null;

  let bookmarks = $state<Bookmark[]>(saved ? JSON.parse(saved) : []);

  function save() {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
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
    addBookmark,
    removeBookmark,
    hasBookmark,
    reorderBookmarks,
  };
}

export const bookmarksStore = createBookmarksState();
