/**
 * Encoder for the binary listing form decoded by `directory-wire.ts`, byte for
 * byte the Rust encoder in `src-tauri/src/files/directory_wire.rs` (#1417).
 * Used by the browser mock backend and tests only, so it is kept out of the
 * startup bundle that carries the decoder.
 */
import type { DirectoryListing } from "$lib/domain/file";
import {
  EMPTY_SHIFT, FLAG_DIRECTORY, FLAG_GIT_REPO, FLAG_SYMLINK, FLAG_SYMLINK_TARGET, FLAG_WIDE_NAME, MAGIC,
  type Header,
} from "./directory-wire";

const isAscii = (value: string) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0x7f) return false;
  return true;
};

/**
 * The inverse of `decodeDirectoryListing`, byte for byte the Rust encoder:
 * the browser mock replies through this so the mock-backed tiers exercise
 * the same decoder as native listings (#868). `extra` fields join the header,
 * after the listing's own, as the watch lease does natively.
 */
export function encodeDirectoryListing(listing: DirectoryListing, extra: Record<string, unknown> = {}): Uint8Array {
  const { entries } = listing;
  const first = entries[0];
  const candidate = first && first.path.endsWith(first.name)
    ? first.path.slice(0, first.path.length - first.name.length)
    : null;
  const prefix = candidate !== null && entries.every((e) => e.path === candidate + e.name) ? candidate : null;
  const hasTargets = entries.some((e) => e.symlink_target !== undefined && e.symlink_target !== null);
  const utf8 = new TextEncoder();
  const columns = [
    entries.filter((e) => isAscii(e.name)).map((e) => e.name).join(""),
    entries.filter((e) => !isAscii(e.name)).map((e) => e.name).join(""),
    entries.map((e) => e.modified).join(""),
    prefix === null ? entries.map((e) => e.path).join("") : "",
    entries.map((e) => e.symlink_target ?? "").join(""),
  ].map((column) => utf8.encode(column));
  const header: Header = {
    path: listing.path, path_prefix: prefix, count: entries.length,
    bytes: columns.map((column) => column.length) as Header["bytes"],
    ...(hasTargets ? { targets: true as const } : {}),
    ...extra,
  };
  const headerBytes = utf8.encode(JSON.stringify(header));
  const unitColumns = 2 + (prefix === null ? 1 : 0) + (hasTargets ? 1 : 0);
  const rows = entries.length * (8 + 4 * unitColumns + 1);
  const out = new Uint8Array(8 + headerBytes.length + rows + columns.reduce((sum, c) => sum + c.length, 0));
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, headerBytes.length, true);
  out.set(headerBytes, 8);
  let at = 8 + headerBytes.length;
  for (const e of entries) { view.setFloat64(at, e.size, true); at += 8; }
  const units = (values: string[]) => { for (const value of values) { view.setUint32(at, value.length, true); at += 4; } };
  units(entries.map((e) => e.name));
  units(entries.map((e) => e.modified));
  if (prefix === null) units(entries.map((e) => e.path));
  if (hasTargets) units(entries.map((e) => e.symlink_target ?? ""));
  for (const e of entries) {
    const empty = e.is_empty === undefined || e.is_empty === null ? 0 : e.is_empty ? 2 : 1;
    out[at++] = (e.kind === "directory" ? FLAG_DIRECTORY : 0) | (e.is_symlink ? FLAG_SYMLINK : 0)
      | (e.is_git_repo ? FLAG_GIT_REPO : 0) | (isAscii(e.name) ? 0 : FLAG_WIDE_NAME)
      | (e.symlink_target !== undefined && e.symlink_target !== null ? FLAG_SYMLINK_TARGET : 0) | (empty << EMPTY_SHIFT);
  }
  for (const column of columns) { out.set(column, at); at += column.length; }
  return out;
}
