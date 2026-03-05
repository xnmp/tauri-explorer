/**
 * Utility for localStorage-backed persistent state.
 * Issue: tauri-qeac
 *
 * Centralizes the repeated pattern of loading/saving JSON from localStorage
 * with guards for SSR/test environments and error handling.
 */

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
  localStorage.setItem(key, JSON.stringify(value));
}

/**
 * Remove a key from localStorage.
 */
export function removePersisted(key: string): void {
  if (!isAvailable) return;
  localStorage.removeItem(key);
}
