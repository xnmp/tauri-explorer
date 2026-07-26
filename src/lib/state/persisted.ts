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

// --- Coalesced localStorage writer (trailing, latest wins) ---

/**
 * A coalescing writer for a single localStorage key.
 *
 * Under WebKitGTK localStorage is SQLite-backed and fsyncs on the UI thread,
 * so one `setItem` can stall for a whole disk flush (~70ms on a DRAM-less
 * SSD). A key rewritten on every user interaction therefore drops a flush
 * stall right into the interaction path — even though every write but the
 * last is immediately superseded and never read (#481).
 *
 * `schedule` moves those writes off that path: the value is held and written
 * once the caller stops scheduling for `delayMs`, so a burst of N
 * interactions costs one write instead of N. Durability is preserved from
 * three directions — `writeNow` for callers that need the value stored
 * synchronously, an automatic flush when the page is hidden or unloaded, and
 * `flush`/`dispose` for explicit teardown.
 */
export interface CoalescedPersister<T> {
  /** Hold `value` for a trailing write, superseding any pending value. */
  schedule(value: T): void;
  /** Write `value` now, discarding any pending write. */
  writeNow(value: T): void;
  /** Write the pending value now, if there is one. */
  flush(): void;
  /** Whether a scheduled write has not landed yet. */
  readonly hasPending: boolean;
  /** Flush, then detach the page-lifecycle listeners. */
  dispose(): void;
}

/**
 * Create a {@link CoalescedPersister} for `key`, coalescing writes that
 * arrive less than `delayMs` apart.
 *
 * The window is trailing and restarts on every `schedule`, so the write lands
 * when the caller pauses — which is exactly when a flush stall is invisible.
 * The flip side is that sustained scheduling can defer a write indefinitely;
 * callers that need a bound on staleness pair this with their own periodic
 * `writeNow` (window-tabs uses the 30s interval save in use-window-lifecycle).
 */
export function createCoalescedPersister<T>(key: string, delayMs: number): CoalescedPersister<T> {
  // Boxed, not a bare `T | undefined`: callers may legitimately persist
  // `undefined`, so emptiness has to be tracked separately from the value.
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Captured once so add/remove always target the same object even if the
  // globals are swapped out underneath us (tests stub them).
  const doc = typeof document !== "undefined" ? document : null;
  const win = typeof window !== "undefined" ? window : null;

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function flush(): void {
    cancelTimer();
    if (!pending) return;
    const { value } = pending;
    pending = null;
    savePersisted(key, value);
  }

  function schedule(value: T): void {
    pending = { value };
    cancelTimer();
    timer = setTimeout(flush, delayMs);
  }

  function writeNow(value: T): void {
    cancelTimer();
    pending = null;
    savePersisted(key, value);
  }

  // Only on the way out: a page becoming visible again has nothing to save.
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === "hidden") flush();
  };
  const onPageHide = (): void => flush();

  doc?.addEventListener("visibilitychange", onVisibilityChange);
  win?.addEventListener("pagehide", onPageHide);
  win?.addEventListener("beforeunload", onPageHide);

  return {
    schedule,
    writeNow,
    flush,
    get hasPending() {
      return pending !== null;
    },
    dispose() {
      flush();
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      win?.removeEventListener("pagehide", onPageHide);
      win?.removeEventListener("beforeunload", onPageHide);
    },
  };
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
