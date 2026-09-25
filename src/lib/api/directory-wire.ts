/** Native IPC schema only. Stores/components consume ordinary immutable entries. */
import type { DirectoryListing, FileEntry } from "$lib/domain/file";

export interface CompactDirectoryListing {
  format: "columns-v1";
  path: string;
  path_prefix: string | null;
  columns: {
    names: string[];
    paths?: string[];
    kinds: ("file" | "directory")[];
    sizes: number[];
    modified: string[];
    is_symlink?: boolean[];
    symlink_target?: (string | null)[];
    is_empty?: (boolean | null)[];
    is_git_repo?: boolean[];
  };
}

export type DirectoryListingPayload = DirectoryListing | CompactDirectoryListing;

function invalid(): never { throw new Error("Invalid native directory snapshot"); }

/**
 * Same field checks the compact (columns-v1) decoder applies per-index,
 * applied to a single reconstructed-shape entry. Required so a malformed
 * legacy-shaped row (missing/wrong-typed fields, or a non-object entry like
 * `null`) is rejected up front instead of publishing and crashing a later
 * consumer (e.g. hidden-file filtering) that assumes valid `FileEntry` shape.
 */
function isValidLegacyEntry(value: unknown): value is FileEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.name === "string" &&
    typeof e.path === "string" &&
    (e.kind === "file" || e.kind === "directory") &&
    Number.isInteger(e.size) && (e.size as number) >= 0 &&
    typeof e.modified === "string" &&
    (e.is_symlink === undefined || typeof e.is_symlink === "boolean") &&
    (e.symlink_target === undefined || typeof e.symlink_target === "string") &&
    (e.is_empty === undefined || typeof e.is_empty === "boolean") &&
    (e.is_git_repo === undefined || typeof e.is_git_repo === "boolean")
  );
}

export function decodeDirectoryListing(payload: DirectoryListingPayload): DirectoryListing {
  if (!payload || typeof payload.path !== "string") return invalid();
  // Trusted browser fixtures retain the legacy domain shape without
  // reconstructing entries, but each row is still validated: a malformed
  // legacy-shaped reply (e.g. a null entry) must be rejected here, not
  // published and left to crash a later consumer.
  if (!("format" in payload) && "entries" in payload && Array.isArray(payload.entries)) {
    if (!payload.entries.every(isValidLegacyEntry)) return invalid();
    return payload;
  }
  if (!("format" in payload) || payload.format !== "columns-v1") return invalid();
  const { columns: c, path_prefix: prefix } = payload;
  if (!c || !Array.isArray(c.names) || (prefix !== null && typeof prefix !== "string")) return invalid();
  if (prefix !== null && c.paths !== undefined) return invalid();
  const count = c.names.length;
  const required = [c.kinds, c.sizes, c.modified, ...(prefix === null ? [c.paths] : [])];
  const optional = [c.is_symlink, c.symlink_target, c.is_empty, c.is_git_repo];
  if (required.some((column) => !Array.isArray(column) || column.length !== count) ||
      optional.some((column) => column !== undefined && (!Array.isArray(column) || column.length !== count))) return invalid();
  const entries = new Array<FileEntry>(count);
  for (let i = 0; i < count; i++) {
    const name = c.names[i];
    const path = prefix === null ? c.paths![i] : prefix + name;
    const kind = c.kinds[i];
    const size = c.sizes[i];
    const modified = c.modified[i];
    const is_symlink = c.is_symlink === undefined ? false : c.is_symlink[i];
    const target = c.symlink_target?.[i];
    const empty = c.is_empty?.[i];
    const is_git_repo = c.is_git_repo === undefined ? false : c.is_git_repo[i];
    if (typeof name !== "string" || typeof path !== "string" ||
        (kind !== "file" && kind !== "directory") || !Number.isInteger(size) || size < 0 ||
        typeof modified !== "string" || typeof is_symlink !== "boolean" ||
        (c.symlink_target !== undefined && target !== null && typeof target !== "string") ||
        (c.is_empty !== undefined && empty !== null && typeof empty !== "boolean") || typeof is_git_repo !== "boolean") return invalid();
    entries[i] = { name, path, kind, size, modified, is_symlink, symlink_target: target ?? undefined, is_empty: empty ?? undefined, is_git_repo };
  }
  return { path: payload.path, entries };
}
