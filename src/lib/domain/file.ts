/**
 * Domain layer for file entry operations.
 * Pure types and functions with no framework dependencies.
 *
 * Issue: tauri-explorer-1yj
 */

export type FileKind = "file" | "directory";
export type ViewMode = "details" | "list" | "tiles";

export function isViewMode(value: unknown): value is ViewMode {
  return value === "details" || value === "list" || value === "tiles";
}

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly modified: string; // ISO 8601
  readonly is_symlink?: boolean;
  readonly symlink_target?: string;
  readonly is_empty?: boolean;
  /** True when this directory is a git repo root (has a `.git` dir or file). */
  readonly is_git_repo?: boolean;
  /** Present only on entries of the in-app Trash location (#863). */
  readonly trash?: TrashEntryInfo;
}

/** Where a trashed entry came from; its `path` is a `trash://` identity. */
export interface TrashEntryInfo {
  /** Opaque native ID; restore resolves it to the captured trash artifact. */
  readonly id: string;
  /** Null when the platform did not record the original location. */
  readonly originalPath: string | null;
  /** ISO 8601, or null when the deletion time is unknown. */
  readonly deletedAt: string | null;
  /** The folder shown in the "Original location" column. */
  readonly originalFolder: string | null;
}

export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
}

/** A committed mutation and an optional, subsequent presentation snapshot.
 * Missing metadata never changes whether the filesystem mutation succeeded. */
export interface FileMutationReceipt {
  readonly path: string;
  readonly entry: FileEntry | null;
  /** Destination exists, but source cleanup is incomplete or uncertain.
   * Neither a Move nor a Copy inverse is safe: the destination may contain
   * the only surviving copy of some source children. */
  readonly recovery?: FileMutationRecovery;
  /** Displaced original belongs to durable recovery, not a path-only Copy inverse. */
  readonly replacement?: { readonly id: string };
  /** A durable move record, already native history's inverse for this move.
   * A path-only Move action could relocate the last copy of the data. */
  readonly relocation?: { readonly id: string };
}

export interface FileMutationRecovery {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly error: string;
  readonly displacedPath?: string;
}

export type SortField = "name" | "size" | "modified" | "type";

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// A shared collator is dramatically cheaper than String#localeCompare, which
// re-derives locale data on every call — and sort comparators run
// O(n·log n) times. Sorting 10k entries by name drops from ~50ms to a few ms.
const nameCollator = new Intl.Collator();

/**
 * Sort file entries with directories first, then by specified field.
 * Returns a new array without mutating the original.
 *
 * Input that is already in order (the backend pre-sorts scans by name, and
 * collation usually agrees for ASCII names) skips the O(n·log n) sort after
 * one linear verification pass. When the orders disagree (locale collation
 * vs the backend's byte order), the check fails and the full sort runs — so
 * the displayed order is always the collator's.
 */
export function sortEntries(
  entries: readonly FileEntry[],
  by: SortField = "name",
  ascending = true
): FileEntry[] {
  // Collation keys are derived once per entry, not per comparison (#1416):
  // a 100k-entry name sort makes ~1.7M comparisons and lowercased both names
  // in each; precomputing halved its time in JavaScriptCore (~200 → ~110 ms).
  const names = by === "size" || by === "modified" ? null : entries.map((e) => e.name.toLowerCase());
  const extensions = by === "type" ? entries.map((e) => fileExtension(e.name)) : null;
  const compare = (i: number, j: number): number => {
    const a = entries[i];
    const b = entries[j];
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
        // ISO-8601 timestamps order lexicographically — plain string
        // comparison, no locale collation needed.
        comparison = a.modified < b.modified ? -1 : a.modified > b.modified ? 1 : 0;
        break;
      case "type": {
        const extA = extensions![i];
        const extB = extensions![j];
        const extCmp = extA < extB ? -1 : extA > extB ? 1 : 0; // already lowercased
        comparison = extCmp !== 0 ? extCmp : nameCollator.compare(names![i], names![j]);
        break;
      }
      default:
        comparison = nameCollator.compare(names![i], names![j]);
    }

    return ascending ? comparison : -comparison;
  };

  let alreadySorted = true;
  for (let i = 1; i < entries.length; i++) {
    if (compare(i - 1, i) > 0) {
      alreadySorted = false;
      break;
    }
  }
  if (alreadySorted) return [...entries];

  // Sorting positions keeps every comparison on the precomputed keys;
  // Array#sort is stable, so equal entries keep their input order as before.
  return Array.from(entries.keys()).sort(compare).map((i) => entries[i]);
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
  "desktop.ini", // Windows folder-customization metadata (#160)
  "thumbs.db", // Windows thumbnail cache
]);

// Lowercasing never changes the length of a name that lowercases to one of
// these ASCII names (A-Z and the Kelvin sign map one unit to one), so names
// of any other length skip the allocation (#1417).
const SYSTEM_HIDDEN_LENGTHS: ReadonlySet<number> = new Set([...SYSTEM_HIDDEN_NAMES].map((name) => name.length));

/** True if `name` is an OS/system folder hidden by default (separate from dotfiles). */
export function isSystemHidden(name: string): boolean {
  return SYSTEM_HIDDEN_LENGTHS.has(name.length) && SYSTEM_HIDDEN_NAMES.has(name.toLowerCase());
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

/**
 * "W × H" pixel resolution for the Preview info row (#1118), or "" when the
 * dimensions are unknown (zero for SVGs without intrinsic size, non-finite).
 */
export function formatResolution(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "";
  if (width <= 0 || height <= 0) return "";
  return `${Math.round(width)} × ${Math.round(height)}`;
}
