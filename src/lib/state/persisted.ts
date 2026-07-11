/**
 * Utility for localStorage-backed persistent state.
 * Issue: tauri-qeac
 *
 * Centralizes the repeated pattern of loading/saving JSON from localStorage
 * with guards for SSR/test environments and error handling.
 *
 * Also provides a serialized, latest-wins writer for config files so that
 * rapid successive saves of the same file can't interleave on disk.
 */

import { writeConfigFile } from "$lib/api/files";

const isAvailable = typeof localStorage !== "undefined";

/**
 * localStorage key for the last-painted background color, as an [r,g,b,a]
 * JSON array. Written by theme.svelte.ts on every theme apply, read by
 * window-appearance.ts to seed new windows' background color before their
 * first paint. Shared as a constant so the two modules can't drift.
 */
export const EXPLORER_BG_RGBA_KEY = "explorer-bg-rgba";

/**
 * Load a value from localStorage, returning the default if not found or invalid.
 */
export function loadPersisted<T>(key: string, defaultValue: T): T {
  if (!isAvailable) return defaultValue;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      return JSON.parse(saved) as T;
    }
  } catch {
    // Ignore parse errors
  }
  return defaultValue;
}

/**
 * Save a value to localStorage as JSON.
 */
export function savePersisted<T>(key: string, value: T): void {
  if (!isAvailable) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Quota exceeded or storage unavailable — don't crash the caller.
    console.warn(`Failed to persist "${key}" to localStorage:`, err);
  }
}

/**
 * Remove a key from localStorage.
 */
export function removePersisted(key: string): void {
  if (!isAvailable) return;
  localStorage.removeItem(key);
}

/**
 * Load a raw (non-JSON) string from localStorage, returning null if missing.
 * Use this for values that predate the JSON-encoded convention above — e.g.
 * plain CSS color strings — where switching to JSON encoding would break
 * existing readers of the raw stored value.
 */
export function loadPersistedRaw(key: string): string | null {
  if (!isAvailable) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Save a raw (non-JSON) string to localStorage as-is.
 */
export function savePersistedRaw(key: string, value: string): void {
  if (!isAvailable) return;
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`Failed to persist "${key}" to localStorage:`, err);
  }
}

// --- Serialized config-file writer (latest wins) ---

const inFlightWrites = new Map<string, Promise<void>>();
const pendingWrites = new Map<string, string>();

/**
 * Write a config file, serializing writes per filename.
 *
 * If a write for the same file is already in flight, the new content is
 * queued and only the most recent queued content is written once the
 * in-flight write completes (latest wins — intermediate states are skipped).
 * Prevents concurrent writes to the same file from interleaving/corrupting it.
 *
 * Returns a promise that resolves once this content (or newer) is on disk.
 */
export function writeConfigQueued(filename: string, data: string): Promise<void> {
  if (inFlightWrites.has(filename)) {
    pendingWrites.set(filename, data);
    return inFlightWrites.get(filename)!;
  }

  const flush = async (content: string): Promise<void> => {
    const result = await writeConfigFile(filename, content);
    if (!result.ok) {
      console.warn(`Failed to write config file "${filename}":`, result.error);
    }
    const next = pendingWrites.get(filename);
    if (next !== undefined) {
      pendingWrites.delete(filename);
      return flush(next);
    }
  };

  const chain = flush(data).finally(() => inFlightWrites.delete(filename));
  inFlightWrites.set(filename, chain);
  return chain;
}
