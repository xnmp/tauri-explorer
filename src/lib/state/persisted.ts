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
  /** Flush, then detach the page-lifecycle listeners. Scheduling after this
   *  writes immediately rather than deferring — there is no flush-on-unload
   *  left to catch a queued value. */
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
  let disposed = false;

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
    // A disposed persister has no page-lifecycle safety net left, so deferring
    // would arm a timer that nothing can flush early. Fail safe: write now
    // rather than risk holding the last value past the page's lifetime.
    if (disposed) {
      savePersisted(key, value);
      return;
    }
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
      disposed = true;
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      win?.removeEventListener("pagehide", onPageHide);
      win?.removeEventListener("beforeunload", onPageHide);
    },
  };
}

// --- Serialized config-file writer (latest wins) ---

const inFlightWrites = new Map<string, Promise<void>>();
const pendingWrites = new Map<string, { data: string; writer: string }>();
const lastWrittenContent = new Map<string, string>();
const writeGenerations = new Map<string, number>();
const activeConfigWriters = new Set<string>();

// Store-owned files retain a stable writer identity without forcing every
// pre-existing two-argument write call (and its public seam) to change.
const configStoreWriter: Record<string, string> = {
  "settings.json": "settings-store",
  "bookmarks.json": "bookmarks-store",
  "folder-views.json": "folder-views-store",
};

/** The file serializes disk writes; the writer identifies ownership of an echo. */
function configWriterKey(filename: string, writer: string): string {
  return `${filename}\u0000${writer}`;
}

/**
 * A snapshot of this process's write activity for `filename`.
 *
 * Config autoreload (#599) samples this on both sides of its read. A boolean
 * "is a write pending" is not enough: a write that *starts and finishes
 * entirely inside* the read window leaves the flag false at both ends while
 * the bytes that came back are already stale. The generation counter closes
 * that hole — it changes for every write issued, so "did any write of ours
 * overlap this read" is answerable no matter how the timing lands.
 */
export interface ConfigWriteActivity {
  /** A write is queued or in flight right now. */
  pending: boolean;
  /** Monotonic count of writes issued for this file in this process. */
  generation: number;
}

export function configWriteActivity(
  filename: string,
  writer = configStoreWriter[filename] ?? filename,
): ConfigWriteActivity {
  const key = configWriterKey(filename, writer);
  return {
    pending: activeConfigWriters.has(key),
    generation: writeGenerations.get(key) ?? 0,
  };
}

/**
 * Whether one of this process's writes overlapped the window between `before`
 * and now — either straddling it, or beginning and completing inside it.
 *
 * When true, whatever was read in that window may predate a write we have
 * already issued, so adopting it would revert the change that write carries.
 */
export function configWriteRaced(
  filename: string,
  before: ConfigWriteActivity,
  writer = configStoreWriter[filename] ?? filename,
): boolean {
  const now = configWriteActivity(filename, writer);
  return before.pending || now.pending || now.generation !== before.generation;
}

/**
 * The content this process most recently sent to disk for `filename`, or null
 * if it has never written it.
 *
 * Filesystem watchers cannot tell our own write from an external edit — both
 * arrive as "the file changed". Comparing against this is what makes a
 * self-write a no-op instead of a reload loop.
 */
export function lastWrittenConfig(
  filename: string,
  writer = configStoreWriter[filename] ?? filename,
): string | null {
  return lastWrittenContent.get(configWriterKey(filename, writer)) ?? null;
}

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
export function writeConfigQueued(
  filename: string,
  data: string,
  writer = configStoreWriter[filename] ?? filename,
): Promise<void> {
  const writerKey = configWriterKey(filename, writer);
  activeConfigWriters.add(writerKey);
  if (inFlightWrites.has(filename)) {
    const replaced = pendingWrites.get(filename);
    // A replacement from the same writer shares its activity key with the
    // write already in flight. Removing that key would create a window where
    // a watcher can adopt stale bytes between the first write and the latest
    // queued replacement.
    if (replaced && replaced.writer !== writer) {
      activeConfigWriters.delete(configWriterKey(filename, replaced.writer));
    }
    pendingWrites.set(filename, { data, writer });
    return inFlightWrites.get(filename)!;
  }

  const flush = async (content: string, contentWriter: string): Promise<void> => {
    // Both recorded before the await, not after: the watcher can report the
    // change before `writeConfigFile` resolves, and an echo that arrives early
    // must still be recognisable as ours.
    const contentWriterKey = configWriterKey(filename, contentWriter);
    lastWrittenContent.set(contentWriterKey, content);
    writeGenerations.set(contentWriterKey, (writeGenerations.get(contentWriterKey) ?? 0) + 1);
    const result = await writeConfigFile(filename, content);
    if (!result.ok) {
      console.warn(`Failed to write config file "${filename}":`, result.error);
    }
    const next = pendingWrites.get(filename);
    if (next !== undefined) {
      pendingWrites.delete(filename);
      // A same-writer queued save hands off directly to the next disk write.
      // Keep it active throughout that handoff: otherwise a watcher read in
      // the second write's window can adopt stale bytes from the first.
      if (next.writer !== contentWriter) activeConfigWriters.delete(contentWriterKey);
      return flush(next.data, next.writer);
    }
    activeConfigWriters.delete(contentWriterKey);
  };

  const chain = flush(data, writer).finally(() => inFlightWrites.delete(filename));
  inFlightWrites.set(filename, chain);
  return chain;
}
