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
  readonly is_symlink?: boolean;
  readonly symlink_target?: string;
  readonly is_empty?: boolean;
}

export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
  readonly listing_id: number | null;
}

export type SortField = "name" | "size" | "modified" | "type";

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

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
      case "type": {
        const extCmp = fileExtension(a.name).localeCompare(fileExtension(b.name));
        comparison = extCmp !== 0
          ? extCmp
          : a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        break;
      }
      default:
        comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }

    return ascending ? comparison : -comparison;
  });

  return sorted;
}

/**
 * Windows/OS system folders that aren't dotfiles but should be hidden by
 * default (they show up at drive roots). Matched case-insensitively against the
 * full entry name. Revealed when "show hidden" is on, like dotfiles.
 */
const SYSTEM_HIDDEN_NAMES: ReadonlySet<string> = new Set([
  "$recycle.bin",
  "$recycler",
  "recycler",
  "recycled",
  "system volume information",
  "$winreagent",
  "$sysreset",
  "$getcurrent",
  "config.msi",
  "documents and settings", // legacy junction
  "msocache",
  "recovery",
  "found.000",
]);

/** True if `name` is an OS/system folder hidden by default (separate from dotfiles). */
export function isSystemHidden(name: string): boolean {
  return SYSTEM_HIDDEN_NAMES.has(name.toLowerCase());
}

/**
 * Filter hidden files: dotfiles, OS/app temp files (`~$`), and known system
 * folders ($RECYCLE.BIN, System Volume Information, …) that don't start with a
 * dot but should still be hidden by default.
 * Returns a new array without mutating the original.
 */
export function filterHidden(
  entries: readonly FileEntry[],
  showHidden: boolean
): FileEntry[] {
  if (showHidden) return [...entries];
  return entries.filter(
    (e) => !e.name.startsWith(".") && !e.name.startsWith("~$") && !isSystemHidden(e.name)
  );
}

/**
 * Format file size for display - Windows 11 style.
 * Shows whole numbers without decimals (e.g., "1 KB" instead of "1.0 KB").
 * Sizes ≥ 1 PB are clamped to TB; negative/non-finite input yields "".
 * Callers that render directories (which have no meaningful size) are
 * expected to skip formatting and show a blank/dash themselves.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes === 0) return "0 bytes";

  const units = ["bytes", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / Math.pow(1024, i);

  // For bytes, show exact count
  if (i === 0) {
    return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  }

  // For larger units, show whole numbers when appropriate
  const formatted = value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}
