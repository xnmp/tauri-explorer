/**
 * Domain layer for file entry operations.
 * Pure types and functions with no framework dependencies.
 *
 * Issue: tauri-explorer-1yj
 */

export type FileKind = "file" | "directory";

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly modified: string; // ISO 8601
}

export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
}

export type SortField = "name" | "size" | "modified";

/**
 * Sort file entries with directories first, then by specified field.
 * Returns a new array without mutating the original.
 */
export function sortEntries(
  entries: readonly FileEntry[],
  by: SortField = "name",
  ascending = true
): FileEntry[] {
  const sorted = [...entries].sort((a, b) => {
    // Directories always first
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }

    let comparison: number;
    switch (by) {
      case "size":
        comparison = a.size - b.size;
        break;
      case "modified":
        comparison = a.modified.localeCompare(b.modified);
        break;
      default:
        comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }

    return ascending ? comparison : -comparison;
  });

  return sorted;
}

/**
 * Filter hidden files (dotfiles).
 * Returns a new array without mutating the original.
 */
export function filterHidden(
  entries: readonly FileEntry[],
  showHidden: boolean
): FileEntry[] {
  if (showHidden) return [...entries];
  return entries.filter((e) => !e.name.startsWith("."));
}

/**
 * Format file size for display.
 * Returns empty string for 0 (directories).
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "";

  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);

  return `${value.toFixed(1)} ${units[i]}`;
}
