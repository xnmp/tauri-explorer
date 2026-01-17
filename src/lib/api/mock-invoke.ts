/**
 * Mock Tauri invoke for browser-based E2E testing.
 * Provides realistic fake data when running outside of Tauri webview.
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";

// Check if we're running in Tauri v2
// Note: Tauri v2 uses __TAURI_INTERNALS__, not __TAURI__ (v1)
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Helper to create ISO date string
const now = new Date().toISOString();

// Helper to create mock file entry
function file(name: string, path: string, size: number): FileEntry {
  return { name, path, kind: "file", size, modified: now };
}

function dir(name: string, path: string): FileEntry {
  return { name, path, kind: "directory", size: 0, modified: now };
}

// Mock file system structure
const mockFiles: Record<string, FileEntry[]> = {
  "/home": [
    dir("user", "/home/user"),
  ],
  "/home/user": [
    dir("Documents", "/home/user/Documents"),
    dir("Downloads", "/home/user/Downloads"),
    dir("Pictures", "/home/user/Pictures"),
    dir("Music", "/home/user/Music"),
    dir("Videos", "/home/user/Videos"),
    dir(".config", "/home/user/.config"),
    file("readme.txt", "/home/user/readme.txt", 1024),
    file("notes.md", "/home/user/notes.md", 2048),
  ],
  "/home/user/Documents": [
    dir("project", "/home/user/Documents/project"),
    file("report.pdf", "/home/user/Documents/report.pdf", 102400),
    file("budget.xlsx", "/home/user/Documents/budget.xlsx", 51200),
    file("presentation.pptx", "/home/user/Documents/presentation.pptx", 204800),
  ],
  "/home/user/Downloads": [
    file("archive.zip", "/home/user/Downloads/archive.zip", 1048576),
    file("installer.exe", "/home/user/Downloads/installer.exe", 5242880),
    file("image.png", "/home/user/Downloads/image.png", 524288),
  ],
  "/home/user/Pictures": [
    dir("vacation", "/home/user/Pictures/vacation"),
    file("photo1.jpg", "/home/user/Pictures/photo1.jpg", 2097152),
    file("photo2.jpg", "/home/user/Pictures/photo2.jpg", 1572864),
    file("screenshot.png", "/home/user/Pictures/screenshot.png", 262144),
  ],
  "/home/user/Music": [
    dir("playlist", "/home/user/Music/playlist"),
    file("song1.mp3", "/home/user/Music/song1.mp3", 4194304),
    file("song2.mp3", "/home/user/Music/song2.mp3", 3670016),
  ],
  "/home/user/Videos": [
    file("recording.mp4", "/home/user/Videos/recording.mp4", 52428800),
    file("tutorial.mkv", "/home/user/Videos/tutorial.mkv", 104857600),
  ],
  "/home/user/Documents/project": [
    dir("src", "/home/user/Documents/project/src"),
    file("package.json", "/home/user/Documents/project/package.json", 512),
    file("README.md", "/home/user/Documents/project/README.md", 4096),
    file("tsconfig.json", "/home/user/Documents/project/tsconfig.json", 256),
  ],
};

// Get directory entries with default empty array for unknown paths
function getDirectoryEntries(path: string): FileEntry[] {
  return mockFiles[path] || [];
}

// Mock command handlers
type CommandHandler = (args: Record<string, unknown>) => unknown;

const mockCommands: Record<string, CommandHandler> = {
  get_home_directory: () => "/home/user",

  list_directory: (args) => {
    const path = args.path as string;
    const entries = getDirectoryEntries(path);
    return { path, entries } as DirectoryListing;
  },

  start_streaming_directory: (args) => {
    const path = args.path as string;
    const entries = getDirectoryEntries(path);
    return { path, entries } as DirectoryListing;
  },

  create_directory: (args) => {
    const parentPath = args.parentPath as string;
    const name = args.name as string;
    const newPath = `${parentPath}/${name}`;
    const entry = dir(name, newPath);
    if (!mockFiles[parentPath]) mockFiles[parentPath] = [];
    mockFiles[parentPath].push(entry);
    mockFiles[newPath] = [];
    return entry;
  },

  rename_entry: (args) => {
    const path = args.path as string;
    const newName = args.newName as string;
    const parentPath = path.substring(0, path.lastIndexOf("/"));
    const entries = mockFiles[parentPath] || [];
    const entryIndex = entries.findIndex((e) => e.path === path);
    if (entryIndex >= 0) {
      const oldEntry = entries[entryIndex];
      const newPath = `${parentPath}/${newName}`;
      const newEntry: FileEntry = { ...oldEntry, name: newName, path: newPath };
      entries[entryIndex] = newEntry;
      return newEntry;
    }
    throw new Error("Entry not found");
  },

  move_to_trash: (args) => {
    const path = args.path as string;
    const parentPath = path.substring(0, path.lastIndexOf("/"));
    const entries = mockFiles[parentPath] || [];
    const entryIndex = entries.findIndex((e) => e.path === path);
    if (entryIndex >= 0) {
      entries.splice(entryIndex, 1);
    }
  },

  copy_entry: (args) => {
    const source = args.source as string;
    const destDir = args.destDir as string;
    const name = source.substring(source.lastIndexOf("/") + 1);
    const sourcePath = source.substring(0, source.lastIndexOf("/"));
    const sourceEntries = mockFiles[sourcePath] || [];
    const sourceEntry = sourceEntries.find((e) => e.path === source);
    if (!sourceEntry) throw new Error("Source not found");

    const newPath = `${destDir}/${name}`;
    const newEntry: FileEntry = { ...sourceEntry, path: newPath };
    if (!mockFiles[destDir]) mockFiles[destDir] = [];
    mockFiles[destDir].push(newEntry);
    return newEntry;
  },

  move_entry: (args) => {
    const source = args.source as string;
    const destDir = args.destDir as string;
    const name = source.substring(source.lastIndexOf("/") + 1);
    const sourcePath = source.substring(0, source.lastIndexOf("/"));
    const sourceEntries = mockFiles[sourcePath] || [];
    const entryIndex = sourceEntries.findIndex((e) => e.path === source);
    if (entryIndex < 0) throw new Error("Source not found");

    const entry = sourceEntries[entryIndex];
    sourceEntries.splice(entryIndex, 1);

    const newPath = `${destDir}/${name}`;
    const newEntry: FileEntry = { ...entry, path: newPath };
    if (!mockFiles[destDir]) mockFiles[destDir] = [];
    mockFiles[destDir].push(newEntry);
    return newEntry;
  },

  open_file: () => {
    // No-op for mock
  },

  fuzzy_search: (args) => {
    const query = (args.query as string).toLowerCase();
    const limit = args.limit as number || 20;
    const results: Array<{ name: string; path: string; relativePath: string; score: number; kind: "file" | "directory" }> = [];

    for (const [dir, entries] of Object.entries(mockFiles)) {
      for (const entry of entries) {
        if (entry.name.toLowerCase().includes(query)) {
          results.push({
            name: entry.name,
            path: entry.path,
            relativePath: entry.path.replace("/home/user/", ""),
            score: 100,
            kind: entry.kind,
          });
          if (results.length >= limit) break;
        }
      }
      if (results.length >= limit) break;
    }

    return { results };
  },

  start_streaming_search: () => {
    return 1; // Mock search ID
  },

  cancel_search: () => {},

  cancel_directory_listing: () => {},

  start_content_search: () => {
    return 1; // Mock search ID
  },

  cancel_content_search: () => {},

  get_thumbnail: () => {
    throw new Error("Thumbnails not available in mock mode");
  },

  get_thumbnail_data: () => {
    // Return a 1x1 gray pixel as placeholder
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  },

  clear_thumbnail_cache: () => 0,

  get_thumbnail_cache_stats: () => ({
    count: 0,
    totalSize: 0,
    path: "/tmp/thumbnails",
  }),
};

/**
 * Mock invoke function for browser-based testing.
 */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Add small delay to simulate async operation
  await new Promise((resolve) => setTimeout(resolve, 10));

  const handler = mockCommands[cmd];
  if (!handler) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  return handler(args || {}) as T;
}
