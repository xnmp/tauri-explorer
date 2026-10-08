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

function invalid(): never { throw new Error("Invalid native directory snapshot"); }

/**
 * The inverse of `decodeDirectoryListing`, mirroring the Rust serializer in
 * `src-tauri/src/files/directory_wire.rs`: a prefix is shared only when it
 * reproduces every path exactly, and optional columns appear only when some
 * row differs from the default. The browser mock replies through this so the
 * mock-backed tiers exercise the same decoder as native listings (#868).
 */
export function encodeDirectoryListing(listing: DirectoryListing): CompactDirectoryListing {
  const { entries } = listing;
  const first = entries[0];
  const candidate = first && first.path.endsWith(first.name)
    ? first.path.slice(0, first.path.length - first.name.length)
    : null;
  const prefix = candidate !== null && entries.every((e) => e.path === candidate + e.name) ? candidate : null;
  const columns: CompactDirectoryListing["columns"] = {
    names: entries.map((e) => e.name),
    ...(prefix === null ? { paths: entries.map((e) => e.path) } : {}),
    kinds: entries.map((e) => e.kind),
    sizes: entries.map((e) => e.size),
    modified: entries.map((e) => e.modified),
  };
  if (entries.some((e) => e.is_symlink)) columns.is_symlink = entries.map((e) => e.is_symlink ?? false);
  if (entries.some((e) => e.symlink_target !== undefined)) columns.symlink_target = entries.map((e) => e.symlink_target ?? null);
  if (entries.some((e) => e.is_empty !== undefined)) columns.is_empty = entries.map((e) => e.is_empty ?? null);
  if (entries.some((e) => e.is_git_repo)) columns.is_git_repo = entries.map((e) => e.is_git_repo ?? false);
  return { format: "columns-v1", path: listing.path, path_prefix: prefix, columns };
}

export function decodeDirectoryListing(payload: CompactDirectoryListing): DirectoryListing {
  if (!payload || typeof payload.path !== "string" || payload.format !== "columns-v1") return invalid();
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
