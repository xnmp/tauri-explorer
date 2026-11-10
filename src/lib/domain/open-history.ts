/**
 * App-owned file open history (#1525): when this app last launched each file.
 *
 * Filesystem atime cannot answer "when did I last open this" (relatime, NTFS
 * last-access often off, every reader bumps it), so the Details "Date opened"
 * column reads this bounded map instead. Pure: the store in
 * `state/open-history.svelte.ts` owns persistence and cross-window publication.
 *
 * Keys are `directoryKey` identities (separator- and, for Windows paths,
 * case-normalized) so a path reported with either separator finds one entry.
 */
import { directoryKey } from "./path";

/** Most files kept; recording past this evicts the least recently opened. */
const OPEN_HISTORY_CAPACITY = 10_000;
/** Serialized documents above this are treated as corrupt (≈16 MiB). */
export const OPEN_HISTORY_MAX_TEXT = 16 * 1024 * 1024;
const MAX_KEY_LENGTH = 32_768;
const MAX_TIME = 8.64e15; // ECMAScript's maximum Date value

export type OpenHistory = ReadonlyMap<string, number>;

/** One change, applied identically by the originating window, by windows that
 * receive it through cross-window publication, and on top of the stored
 * document when saving. */
export type OpenHistoryOp =
  | { readonly type: "open"; readonly path: string; readonly at: number }
  | { readonly type: "move"; readonly from: string; readonly to: string }
  | { readonly type: "forget"; readonly paths: readonly string[] };

const openHistoryKey = (path: string): string => directoryKey(path);

const validKey = (key: unknown): key is string =>
  typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH && !key.includes("\0");
const validTime = (at: unknown): at is number =>
  typeof at === "number" && Number.isFinite(at) && at > 0 && at <= MAX_TIME;

/** When `path` was last opened (epoch ms), or undefined if never. */
export function lastOpened(history: OpenHistory, path: string): number | undefined {
  return history.get(openHistoryKey(path));
}

/** Keep the `capacity` most recently opened entries. */
function bound(history: Map<string, number>, capacity: number): Map<string, number> {
  if (history.size <= capacity) return history;
  if (history.size === capacity + 1) {
    // The common single-insert case: drop the one oldest, O(n) not O(n log n).
    let oldest: string | undefined;
    let oldestAt = Infinity;
    for (const [key, at] of history) if (at < oldestAt) { oldest = key; oldestAt = at; }
    history.delete(oldest!);
    return history;
  }
  return new Map([...history].sort((a, b) => b[1] - a[1]).slice(0, capacity));
}

const isWithin = (key: string, root: string): boolean =>
  key === root || key.startsWith(root.endsWith("/") ? root : `${root}/`);

/** Apply one change to `next` in place. */
function mutate(next: Map<string, number>, op: OpenHistoryOp, capacity: number): Map<string, number> {
  switch (op.type) {
    case "open": {
      const key = openHistoryKey(op.path);
      if (!validKey(key) || !validTime(op.at)) return next;
      // Max wins: a replayed or late-delivered older open never moves it back.
      next.set(key, Math.max(next.get(key) ?? 0, op.at));
      return bound(next, capacity);
    }
    case "move": {
      // A file carries its timestamp; a folder carries every descendant's.
      const from = openHistoryKey(op.from);
      const to = openHistoryKey(op.to);
      if (from === to || !validKey(to)) return next;
      const moving = [...next].filter(([key]) => isWithin(key, from));
      for (const [key] of moving) next.delete(key);
      for (const [key, at] of moving) {
        const moved = to + key.slice(from.length);
        next.set(moved, Math.max(next.get(moved) ?? 0, at));
      }
      return next;
    }
    case "forget": {
      const roots = op.paths.map(openHistoryKey);
      for (const key of [...next.keys()]) if (roots.some((root) => isWithin(key, root))) next.delete(key);
      return next;
    }
  }
}

/** Apply one change, returning a new map (the input is never mutated). */
export function applyOpenHistoryOp(history: OpenHistory, op: OpenHistoryOp, capacity = OPEN_HISTORY_CAPACITY): Map<string, number> {
  return mutate(new Map(history), op, capacity);
}

/** Apply changes in order, copying the history once. */
export function replayOpenHistory(history: OpenHistory, ops: readonly OpenHistoryOp[], capacity = OPEN_HISTORY_CAPACITY): Map<string, number> {
  return ops.reduce<Map<string, number>>((current, op) => mutate(current, op, capacity), new Map(history));
}

/** Union of two histories; the later timestamp wins for a shared path. */
export function mergeOpenHistories(a: OpenHistory, b: OpenHistory, capacity = OPEN_HISTORY_CAPACITY): Map<string, number> {
  const merged = new Map(a);
  for (const [key, at] of b) merged.set(key, Math.max(merged.get(key) ?? 0, at));
  return bound(merged, capacity);
}

export function serializeOpenHistory(history: OpenHistory): string {
  return JSON.stringify({ version: 1, entries: Object.fromEntries(history) });
}

/** Parse a stored document. Anything malformed — invalid JSON, a wrong shape,
 * an oversized document, individual bad entries — yields what is valid, and
 * at worst an empty history; it never throws. */
export function parseOpenHistory(text: unknown, capacity = OPEN_HISTORY_CAPACITY): Map<string, number> {
  if (typeof text !== "string" || !text || text.length > OPEN_HISTORY_MAX_TEXT) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return new Map(); }
  const entries = typeof parsed === "object" && parsed !== null ? (parsed as { entries?: unknown }).entries : undefined;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return new Map();
  const history = new Map<string, number>();
  for (const [key, at] of Object.entries(entries)) if (validKey(key) && validTime(at)) history.set(key, at);
  return bound(history, capacity);
}

/** Validate a change received from another window. */
export function isOpenHistoryOp(value: unknown): value is OpenHistoryOp {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Record<string, unknown>;
  switch (op.type) {
    case "open": return validKey(op.path) && validTime(op.at);
    case "move": return validKey(op.from) && validKey(op.to);
    case "forget": return Array.isArray(op.paths) && op.paths.length <= 100_000 && op.paths.every(validKey);
    default: return false;
  }
}
