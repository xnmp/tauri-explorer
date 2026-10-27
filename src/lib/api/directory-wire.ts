/**
 * Native IPC schema only. Stores/components consume ordinary immutable entries.
 *
 * A listing arrives as bytes in the binary form documented in
 * `src-tauri/src/files/directory_wire.rs` (#1417): a JSON header, fixed-width
 * little-endian columns, then UTF-8 string columns. Each string column is
 * decoded with one `TextDecoder` call and sliced per row; that replaced a JSON
 * reply whose parse dominated large-folder opens.
 */
import type { DirectoryListing, FileEntry } from "$lib/domain/file";

/** A native listing reply as Tauri delivers a raw body. */
export type DirectoryListingBytes = ArrayBuffer | ArrayBufferView;

const MAGIC = [0x54, 0x45, 0x4c, 0x31]; // "TEL1"
const FLAG_DIRECTORY = 1;
const FLAG_SYMLINK = 1 << 1;
const FLAG_GIT_REPO = 1 << 2;
const FLAG_WIDE_NAME = 1 << 3;
const FLAG_SYMLINK_TARGET = 1 << 4;
const EMPTY_SHIFT = 5;
const FLAG_BITS = (1 << 7) - 1;

interface Header {
  path: string;
  path_prefix: string | null;
  count: number;
  /** UTF-8 byte lengths: ASCII names, other names, modified, paths, symlink targets. */
  bytes: [number, number, number, number, number];
  targets?: true;
  [extra: string]: unknown;
}

function invalid(): never { throw new Error("Invalid native directory snapshot"); }

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

/** A slice whose unit counts cut a surrogate pair in two. ASCII slices never do. */
const splitsPair = (value: string) => value.length > 0 &&
  ((value.charCodeAt(0) & 0xfc00) === 0xdc00 || (value.charCodeAt(value.length - 1) & 0xfc00) === 0xd800);

const naturalNumber = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function parseHeader(bytes: Uint8Array, decoder: TextDecoder): { header: Header; end: number } {
  if (bytes.length < 8 || MAGIC.some((byte, i) => bytes[i] !== byte)) invalid();
  const length = new DataView(bytes.buffer, bytes.byteOffset, 8).getUint32(4, true);
  if (8 + length > bytes.length) invalid();
  let header: Header;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(8, 8 + length)));
  } catch {
    return invalid();
  }
  if (!header || typeof header !== "object" || typeof header.path !== "string" ||
      (header.path_prefix !== null && typeof header.path_prefix !== "string") ||
      !naturalNumber(header.count) || !Array.isArray(header.bytes) || header.bytes.length !== 5 ||
      !header.bytes.every(naturalNumber) || (header.targets !== undefined && header.targets !== true)) invalid();
  return { header, end: 8 + length };
}

/**
 * The header fields beyond the listing's own (such as a watch lease) of a
 * reply whose rows may be malformed, or null when even the header is
 * unreadable. Lets the caller release a lease the reply carried even when
 * the listing itself is rejected.
 */
export function decodeDirectoryListingExtra(payload: DirectoryListingBytes): Record<string, unknown> | null {
  try {
    const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    const { path: _path, path_prefix: _prefix, count: _count, bytes: _bytes, targets: _targets, ...extra } =
      parseHeader(bytes, new TextDecoder("utf-8", { fatal: true })).header;
    return extra;
  } catch {
    return null;
  }
}

/**
 * Decode a native listing. Any inconsistency (lengths that do not add up,
 * unknown flags, invalid UTF-8) rejects the whole snapshot rather than
 * publishing partial entries. Header fields beyond the listing's own (such as
 * a watch lease) are returned as `extra` for the caller to validate.
 */
export function decodeDirectoryListing(payload: DirectoryListingBytes): DirectoryListing & { extra: Record<string, unknown> } {
  if (!(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)) return invalid();
  const bytes = payload instanceof ArrayBuffer
    ? new Uint8Array(payload)
    : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const { header, end } = parseHeader(bytes, decoder);
  const { count, path_prefix: prefix } = header;
  const hasPaths = prefix === null;
  const hasTargets = header.targets === true;
  const columnsStart = end;
  const unitColumns = 2 + (hasPaths ? 1 : 0) + (hasTargets ? 1 : 0);
  const stringsStart = columnsStart + count * (8 + 4 * unitColumns + 1);
  const totalBytes = header.bytes.reduce((sum, n) => sum + n, 0);
  if (stringsStart + totalBytes !== bytes.length) return invalid();

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const strings: string[] = [];
  let at = stringsStart;
  try {
    for (const length of header.bytes) {
      strings.push(decoder.decode(bytes.subarray(at, at + length)));
      at += length;
    }
  } catch {
    return invalid();
  }
  const [asciiNames, wideNames, modifiedColumn, pathColumn, targetColumn] = strings;
  const sizesAt = columnsStart;
  const nameUnitsAt = sizesAt + 8 * count;
  const modifiedUnitsAt = nameUnitsAt + 4 * count;
  const pathUnitsAt = modifiedUnitsAt + 4 * count;
  const targetUnitsAt = pathUnitsAt + (hasPaths ? 4 * count : 0);
  const flagsAt = targetUnitsAt + (hasTargets ? 4 * count : 0);

  const entries = new Array<FileEntry>(count);
  let asciiAt = 0, wideAt = 0, modifiedAt = 0, pathAt = 0, targetAt = 0;
  for (let i = 0; i < count; i++) {
    const flags = bytes[flagsAt + i];
    const size = view.getFloat64(sizesAt + 8 * i, true);
    const nameUnits = view.getUint32(nameUnitsAt + 4 * i, true);
    const modifiedUnits = view.getUint32(modifiedUnitsAt + 4 * i, true);
    const empty = flags >> EMPTY_SHIFT;
    if ((flags & ~FLAG_BITS) !== 0 || empty === 3 || !Number.isInteger(size) || size < 0) return invalid();
    if (!hasTargets && flags & FLAG_SYMLINK_TARGET) return invalid();
    let name: string;
    if (flags & FLAG_WIDE_NAME) {
      name = wideNames.substring(wideAt, wideAt += nameUnits);
      if (splitsPair(name)) return invalid();
    } else {
      name = asciiNames.substring(asciiAt, asciiAt += nameUnits);
    }
    const modified = modifiedColumn.substring(modifiedAt, modifiedAt += modifiedUnits);
    let path: string;
    if (hasPaths) {
      const units = view.getUint32(pathUnitsAt + 4 * i, true);
      path = pathColumn.substring(pathAt, pathAt += units);
      if (splitsPair(path)) return invalid();
    } else {
      path = prefix + name;
    }
    let symlinkTarget: string | undefined;
    if (hasTargets) {
      const units = view.getUint32(targetUnitsAt + 4 * i, true);
      if (flags & FLAG_SYMLINK_TARGET) {
        symlinkTarget = targetColumn.substring(targetAt, targetAt += units);
        if (splitsPair(symlinkTarget)) return invalid();
      } else if (units !== 0) return invalid();
    }
    entries[i] = {
      name, path, kind: flags & FLAG_DIRECTORY ? "directory" : "file", size, modified,
      is_symlink: (flags & FLAG_SYMLINK) !== 0, symlink_target: symlinkTarget,
      is_empty: empty === 0 ? undefined : empty === 2, is_git_repo: (flags & FLAG_GIT_REPO) !== 0,
    };
  }
  // Every column must be consumed exactly: a short unit count leaves text over.
  if (asciiAt !== asciiNames.length || wideAt !== wideNames.length || modifiedAt !== modifiedColumn.length ||
      pathAt !== pathColumn.length || targetAt !== targetColumn.length) return invalid();

  const { path, path_prefix: _prefix, count: _count, bytes: _bytes, targets: _targets, ...extra } = header;
  return { path, entries, extra };
}
