/** Pure validation for data received from another window or launch source. */
import { isViewMode, type FileEntry, type SortField, type ViewMode } from "./file";
import { directoryKey } from "./path";

// Seeds are an optional first-paint optimization. Larger listings load normally
// instead of making a new window parse/validate an unbounded synchronous copy.
export const WINDOW_SEED_MAX_CHARS = 1_048_576;
export const DIRECTORY_SEED_MAX_ENTRIES = 10_000;

/** Check plain window messages against the receiver's JSON character limit
 * without allocating a serialized copy of an arbitrarily large layout. */
export function windowSeedFitsBudget(value: unknown): boolean {
  let remaining = WINDOW_SEED_MAX_CHARS;
  const ancestors = new Set<object>();
  const spend = (chars: number) => (remaining -= chars) >= 0;
  const string = (text: string) => text.length <= remaining && spend(JSON.stringify(text).length);
  function visit(item: unknown, depth: number): boolean {
    if (depth > 64) return false;
    if (item === null) return spend(4);
    if (typeof item === "string") return string(item);
    if (typeof item === "boolean") return spend(item ? 4 : 5);
    if (typeof item === "number") return Number.isFinite(item) && spend(JSON.stringify(item).length);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    ancestors.add(item);
    try {
      if (!spend(2)) return false;
      if (Array.isArray(item)) {
        if (item.length > remaining + 1) return false;
        for (let i = 0; i < item.length; i++) {
          if ((i > 0 && !spend(1)) || !visit(item[i] ?? null, depth + 1)) return false;
        }
        return true;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return false;
      let first = true;
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        const entry = (item as Record<string, unknown>)[key];
        if (entry === undefined) continue;
        if ((!first && !spend(1)) || !string(key) || !spend(1) || !visit(entry, depth + 1)) return false;
        first = false;
      }
      return true;
    } finally { ancestors.delete(item); }
  }
  return visit(value, 0);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isWindowPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0");
}

export function isFreshSeed(value: unknown, now: number, lifetimeMs: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value <= now && now - value < lifetimeMs;
}

export interface ExplorerSeed {
  currentPath: string;
  entries: FileEntry[];
  sortBy: SortField;
  sortAscending: boolean;
  viewMode: ViewMode;
}

/** Conservative JSON-size estimate, checked before serializing an optional
 * seed. Six characters per source character covers JSON escaping. */
export function directorySeedFitsBudget(seed: ExplorerSeed): boolean {
  if (seed.entries.length > DIRECTORY_SEED_MAX_ENTRIES) return false;
  let chars = 256 + seed.currentPath.length * 6;
  for (const entry of seed.entries) {
    chars += 256 + 6 * (entry.name.length + entry.path.length + entry.modified.length + (entry.symlink_target?.length ?? 0));
    if (chars > WINDOW_SEED_MAX_CHARS) return false;
  }
  return chars <= WINDOW_SEED_MAX_CHARS;
}

function normalizeSeedEntry(raw: unknown, root: string, windowsPaths: boolean): FileEntry | null {
  const key = (path: string) => windowsPaths ? directoryKey(path) : path;
  if (!isRecord(raw) || !isWindowPath(raw.path) || !isWindowPath(raw.name)
    || raw.name === "." || raw.name === ".." || raw.name.includes("/") || (windowsPaths && raw.name.includes("\\"))
    || key(raw.path) !== key(`${root.replace(windowsPaths ? /[\\/]+$/ : /\/+$/, "")}/${raw.name}`)
    || (raw.kind !== "file" && raw.kind !== "directory")
    || typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size < 0
    || typeof raw.modified !== "string" || raw.modified.length > 128) return null;
  for (const key of ["is_symlink", "is_empty", "is_git_repo"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") return null;
  }
  if (raw.symlink_target !== undefined && !isWindowPath(raw.symlink_target)) return null;
  return {
    name: raw.name, path: raw.path, kind: raw.kind, size: raw.size, modified: raw.modified,
    ...(raw.is_symlink !== undefined ? { is_symlink: raw.is_symlink as boolean } : {}),
    ...(raw.is_empty !== undefined ? { is_empty: raw.is_empty as boolean } : {}),
    ...(raw.is_git_repo !== undefined ? { is_git_repo: raw.is_git_repo as boolean } : {}),
    ...(raw.symlink_target !== undefined ? { symlink_target: raw.symlink_target as string } : {}),
  };
}

/** Reject the whole optional listing on corruption; a partial seed would lie
 * about directory contents. The ordinary backend listing remains authoritative. */
export function normalizeDirectorySeed(raw: unknown, path: string, now: number): ExplorerSeed | null {
  if (!isRecord(raw) || raw.currentPath !== path || !isWindowPath(path)
    || !isFreshSeed(raw.ts, now, 5_000) || !Array.isArray(raw.entries)
    || raw.entries.length > DIRECTORY_SEED_MAX_ENTRIES || !isViewMode(raw.viewMode)
    || (raw.sortBy !== "name" && raw.sortBy !== "size" && raw.sortBy !== "modified" && raw.sortBy !== "type")
    || typeof raw.sortAscending !== "boolean") return null;
  const entries: FileEntry[] = [];
  const paths = new Set<string>();
  const windowsPaths = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\") || path.startsWith("//");
  for (const value of raw.entries) {
    const entry = normalizeSeedEntry(value, path, windowsPaths);
    if (!entry) return null;
    const key = windowsPaths ? directoryKey(entry.path) : entry.path;
    if (paths.has(key)) return null;
    paths.add(key);
    entries.push(entry);
  }
  return { currentPath: path, entries, sortBy: raw.sortBy as SortField, sortAscending: raw.sortAscending, viewMode: raw.viewMode };
}

export interface WarmActivatePayload {
  path: string;
  viewMode?: ViewMode;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  measure?: boolean;
}

export function normalizeWarmActivation(raw: unknown): WarmActivatePayload | null {
  if (!isRecord(raw) || !isWindowPath(raw.path)) return null;
  if (raw.viewMode !== undefined && !isViewMode(raw.viewMode)) return null;
  if (raw.measure !== undefined && typeof raw.measure !== "boolean") return null;
  for (const key of ["x", "y", "width", "height"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value)
      || Math.abs(value) > 2_147_483_647 || ((key === "width" || key === "height") && value <= 0))) return null;
  }
  if ((raw.x === undefined) !== (raw.y === undefined) || (raw.width === undefined) !== (raw.height === undefined)) return null;
  return {
    path: raw.path,
    ...(raw.viewMode !== undefined ? { viewMode: raw.viewMode as ViewMode } : {}),
    ...(raw.x !== undefined ? { x: raw.x as number, y: raw.y as number } : {}),
    ...(raw.width !== undefined ? { width: raw.width as number, height: raw.height as number } : {}),
    ...(raw.measure !== undefined ? { measure: raw.measure as boolean } : {}),
  };
}

export function normalizeLaunchData(raw: unknown): { cwd?: string; home?: string } {
  if (!isRecord(raw)) return {};
  return {
    ...(isWindowPath(raw.cwd) ? { cwd: raw.cwd } : {}),
    ...(isWindowPath(raw.home) ? { home: raw.home } : {}),
  };
}
