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
