/**
 * Shared file open history (#1525) behind the Details "Date opened" column.
 *
 * - Records only successful launches (`onFileLaunched` in `api/open.ts`, wired
 *   by the startup-light `open-history-access.svelte.ts`, which loads this lazily).
 * - Loads lazily (first column/sort read or first record), never at startup;
 *   a missing or corrupt document is an empty history.
 * - Every change is an `OpenHistoryOp`, applied locally and published to the
 *   other windows over a BroadcastChannel.
 * - Saves are coalesced. A save re-reads the stored document, merges this
 *   window's view and replays the changes it has seen since its last save, so
 *   concurrent windows neither drop each other's opens nor resurrect deletions.
 */
import { readOpenHistory, writeOpenHistory } from "$lib/api/open-history";
import type { ApiResult } from "$lib/api/common";
import {
  applyOpenHistoryOp, isOpenHistoryOp, lastOpened, mergeOpenHistories, parseOpenHistory,
  replayOpenHistory, serializeOpenHistory, type OpenHistory, type OpenHistoryOp,
} from "$lib/domain/open-history";

const CHANNEL = "tauri-explorer-open-history";
/** Unsaved changes kept for replay; older ones are already on disk in practice. */
const MAX_UNSAVED = 1_000;

interface Publisher {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface OpenHistoryDeps {
  read: () => Promise<ApiResult<string>>;
  write: (data: string) => Promise<ApiResult<void>>;
  channel?: Publisher | null;
  now?: () => number;
  saveDelayMs?: number;
}

export function createOpenHistoryStore({ read, write, channel = null, now = () => Date.now(), saveDelayMs = 500 }: OpenHistoryDeps) {
  let history = $state.raw<OpenHistory>(new Map());
  let loading: Promise<void> | null = null;
  /** Changes applied since the last save (own and received), replayed on top
   * of the stored document so a stale copy cannot undo them. */
  let unsaved: OpenHistoryOp[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let saveAgain = false;
  /** This window has its own changes not yet written. */
  let dirty = false;

  async function readStored(): Promise<Map<string, number>> {
    try {
      const result = await read();
      return result.ok ? parseOpenHistory(result.data) : new Map();
    } catch {
      return new Map();
    }
  }

  /** Start loading once. Safe to call from a derived read: state is written
   * only after the asynchronous read settles. */
  function ensureLoaded(): Promise<void> {
    loading ??= readStored().then((stored) => {
      // Changes made before the load finished win over the stored copy.
      history = replayOpenHistory(mergeOpenHistories(stored, history), unsaved);
    });
    return loading;
  }

  function apply(op: OpenHistoryOp): void {
    history = applyOpenHistoryOp(history, op);
    unsaved.push(op);
    if (unsaved.length > MAX_UNSAVED) unsaved.splice(0, unsaved.length - MAX_UNSAVED);
  }

  function change(op: OpenHistoryOp): void {
    apply(op);
    dirty = true;
    try { channel?.postMessage(op); } catch { /* Publication is best-effort. */ }
    scheduleSave();
  }

  function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, saveDelayMs);
  }

  async function saveOnce(): Promise<void> {
    await ensureLoaded();
    const replay = unsaved;
    unsaved = [];
    dirty = false;
    const stored = await readStored();
    const next = replayOpenHistory(mergeOpenHistories(stored, history), replay);
    const result = await write(serializeOpenHistory(next)).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    if (!result.ok) {
      unsaved = [...replay, ...unsaved].slice(-MAX_UNSAVED);
      dirty = true;
      console.warn("Open history could not be saved", result.error);
      return;
    }
    // Adopt what other windows saved meanwhile, keeping changes seen since.
    history = replayOpenHistory(mergeOpenHistories(next, history), unsaved);
  }

  /** Write pending changes now (coalesced with any save in flight). */
  async function flush(): Promise<void> {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty && !saving) return;
    if (saving) { saveAgain = true; return saving; }
    saving = (async () => {
      do { saveAgain = false; await saveOnce(); } while (saveAgain && dirty);
    })().finally(() => { saving = null; });
    return saving;
  }

  if (channel) {
    channel.onmessage = (event) => {
      if (isOpenHistoryOp(event.data)) apply(event.data);
    };
  }

  return {
    /** Epoch ms of the last successful launch of `path`, or undefined. */
    lastOpened(path: string): number | undefined {
      void ensureLoaded();
      return lastOpened(history, path);
    },
    /** Reactive history snapshot, for sorting. */
    get history(): OpenHistory {
      void ensureLoaded();
      return history;
    },
    record(path: string, at = now()): void { change({ type: "open", path, at }); },
    /** An in-app rename/move: the entry (and a folder's descendants) keep their timestamps. */
    move(from: string, to: string): void { if (from !== to) change({ type: "move", from, to }); },
    /** Deleted or trashed paths (and their descendants) leave the history. */
    forget(paths: readonly string[]): void { if (paths.length) change({ type: "forget", paths }); },
    ensureLoaded,
    flush,
  };
}

function browserChannel(): Publisher | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try { return new BroadcastChannel(CHANNEL) as unknown as Publisher; } catch { return null; }
}

export const openHistoryStore = createOpenHistoryStore({ read: readOpenHistory, write: writeOpenHistory, channel: browserChannel() });
// A window closing inside the coalescing delay still hands its opens to disk.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => void openHistoryStore.flush());
