/**
 * Bounded breadth-first listing walk beneath a pane for the Folder Peek filter
 * (#1510). Listings do not depend on the query, so one walk serves every
 * keystroke of a filter session; the query is matched in
 * `domain/peek-filter.ts`. Depth, directory and entry caps bound the walk;
 * `start` supersedes and `stop` cancels it (late replies are dropped; no new
 * listing is requested after either).
 */
import type { FileEntry } from "$lib/domain/file";
import { PEEK_FILTER_MAX_DIRECTORIES, PEEK_FILTER_MAX_ENTRIES, scanReaches } from "$lib/domain/peek-filter";

export interface PeekFilterScanOptions {
  /** One directory's listing, or null when it cannot be read. */
  list(path: string): Promise<readonly FileEntry[] | null>;
  /** The entries the pane would show of a listing (hidden rules). */
  visible(entries: readonly FileEntry[], parent: string): readonly FileEntry[];
  /** New listings arrived (coalesced while the walk runs). */
  onChange(): void;
  maxDepth?: number;
  maxDirectories?: number;
  maxEntries?: number;
  concurrency?: number;
  /** Coalescing delay for `onChange` while listings stream in. */
  notifyDelayMs?: number;
}

export function createPeekFilterScan(options: PeekFilterScanOptions) {
  const maxDirectories = options.maxDirectories ?? PEEK_FILTER_MAX_DIRECTORIES;
  const maxEntries = options.maxEntries ?? PEEK_FILTER_MAX_ENTRIES;
  const concurrency = options.concurrency ?? 4;
  const delay = options.notifyDelayMs ?? 50;
  const cache = new Map<string, readonly FileEntry[]>();
  let root: string | null = null;
  let generation = 0;
  let entryCount = 0;
  let requested = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => { clearTimeout(timer); timer = undefined; options.onChange(); };
  const notifySoon = () => { timer ??= setTimeout(flush, delay); };
  const capped = () => cache.size + requested >= maxDirectories || entryCount >= maxEntries;

  function start(nextRoot: string, entries: readonly FileEntry[]) {
    if (nextRoot !== root) { cache.clear(); entryCount = 0; root = nextRoot; }
    const current = ++generation;
    requested = 0;
    const queue: { path: string; level: number }[] = [];
    let head = 0;
    let inFlight = 0;
    const seen = new Set<string>();
    /** Queues the uncached folders of a listing; walks cached ones in place. */
    const plan = (listing: readonly FileEntry[], parent: string, level: number) => {
      if (!scanReaches(level, options.maxDepth)) return;
      for (const entry of options.visible(listing, parent)) {
        if (entry.kind !== "directory" || seen.has(entry.path)) continue;
        seen.add(entry.path);
        const cached = cache.get(entry.path);
        if (cached) plan(cached, entry.path, level + 1);
        else queue.push({ path: entry.path, level });
      }
    };
    plan(entries, nextRoot, 1);
    const live = () => current === generation;
    const pump = () => {
      while (live() && inFlight < concurrency && head < queue.length && !capped()) {
        const { path, level } = queue[head++];
        inFlight++; requested++;
        void options.list(path).catch(() => null).then(listing => {
          if (!live()) return;
          inFlight--; requested--;
          const children = listing ?? [];
          cache.set(path, children);
          entryCount += children.length;
          plan(children, path, level + 1);
          pump();
          if (inFlight === 0) { running = false; flush(); } else notifySoon();
        });
      }
    };
    running = true;
    pump();
    if (inFlight === 0) { running = false; flush(); }
  }

  return {
    start,
    /** Cancels the walk and forgets its listings (the filter session ended). */
    stop() {
      generation++; requested = 0; running = false;
      clearTimeout(timer); timer = undefined;
      cache.clear(); entryCount = 0; root = null;
    },
    listing(path: string): readonly FileEntry[] | undefined { return cache.get(path); },
    /** Listings still being requested. */
    get running() { return running; },
    /** Whether a cap stopped the walk short. */
    get truncated() { return capped(); },
  };
}
