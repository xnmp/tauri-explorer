/**
 * AI column definitions and their bounded value cache, persisted in the
 * plugin's storage (#1884, #1886). Definition changes are written at once; values
 * are written on a debounce, never once per row. Rules live in
 * `domain/ai-column.ts`; this module owns the in-memory copy and the writes.
 *
 * Every window runs its own copy of the plugin against one storage file, so a
 * write re-reads the file and applies only this window's change (an add, a
 * remove, or the values answered since the last write): a stale in-memory
 * copy never overwrites another window's columns. A failed read skips the
 * write rather than overwrite the file with this window's guess.
 */
import {
  cacheDropColumn, cacheDropPaths, cacheLookup, cacheStore, createColumn, normalizeColumns, normalizeValueCache, valueKeyPath,
  type AiColumnDefinition, type AiValueCache,
} from "$lib/domain/ai-column";

export interface AiColumnStorage {
  get(): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

export interface AiColumnStoreOptions {
  delayMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onWriteError?: (error: unknown) => void;
}

interface Persisted { columns: readonly AiColumnDefinition[]; values: AiValueCache }

function parse(raw: Record<string, unknown>): Persisted {
  const columns = normalizeColumns(raw.columns);
  return { columns, values: normalizeValueCache(raw.values, columns.map((column) => column.id)) };
}

export function createAiColumnStore(storage: AiColumnStorage, options: AiColumnStoreOptions = {}) {
  const { delayMs = 1500, onWriteError = (error) => console.warn("[ai-columns] could not save", error) } = options;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const read = () => storage.get().then(parse);
  let state: Persisted = { columns: [], values: {} };
  /** Values answered since the last write, per column. */
  let unsaved = new Map<string, (readonly [string, string])[]>();
  let timer: unknown;
  let writing: Promise<void> = Promise.resolve();

  /** Serialised read-modify-write of the stored file. */
  function write(change: (stored: Persisted) => Persisted): Promise<void> {
    writing = writing
      .then(async () => {
        const next = change(await read());
        await storage.set({ version: 1, columns: next.columns, values: next.values });
      })
      .catch(onWriteError);
    return writing;
  }

  function writeValues(): Promise<void> {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    const pending = unsaved;
    unsaved = new Map();
    if (pending.size === 0) return writing;
    return write((stored) => ({
      columns: stored.columns,
      values: [...pending].reduce(
        (values, [id, pairs]) => stored.columns.some((column) => column.id === id) ? cacheStore(values, id, pairs) : values,
        stored.values),
    }));
  }

  return {
    async load(): Promise<void> {
      state = await read().catch(() => parse({}));
    },
    get columns(): readonly AiColumnDefinition[] { return state.columns; },
    /** The new column, or null for an empty description or a full set. */
    add(description: string): AiColumnDefinition | null {
      const column = createColumn(description, state.columns);
      if (!column) return null;
      state = { ...state, columns: [...state.columns, column] };
      void write((stored) => stored.columns.some((other) => other.id === column.id)
        ? stored
        : { ...stored, columns: [...stored.columns, column] });
      return column;
    },
    /** Forget a column and every value cached for it. */
    remove(id: string): boolean {
      if (!state.columns.some((column) => column.id === id)) return false;
      const drop = (stored: Persisted): Persisted =>
        ({ columns: stored.columns.filter((column) => column.id !== id), values: cacheDropColumn(stored.values, id) });
      state = drop(state);
      unsaved.delete(id);
      void write(drop);
      return true;
    },
    /** Forget the values of files whose path matches `drop` (a folder refresh). */
    dropPaths(id: string, drop: (path: string) => boolean): void {
      if (!state.columns.some((column) => column.id === id)) return;
      state = { ...state, values: cacheDropPaths(state.values, id, drop) };
      const pending = unsaved.get(id)?.filter(([key]) => !drop(valueKeyPath(key)));
      if (pending) unsaved.set(id, pending);
      void write((stored) => ({ ...stored, values: cacheDropPaths(stored.values, id, drop) }));
    },
    lookup: (id: string, key: string): string | undefined => cacheLookup(state.values, id, key),
    store(id: string, pairs: readonly (readonly [string, string])[]): void {
      if (pairs.length === 0 || !state.columns.some((column) => column.id === id)) return;
      state = { ...state, values: cacheStore(state.values, id, pairs) };
      unsaved.set(id, [...(unsaved.get(id) ?? []), ...pairs]);
      if (timer === undefined) timer = setTimer(() => { timer = undefined; void writeValues(); }, delayMs);
    },
    /** Write pending values now (deactivation) and wait for every write. */
    flush(): Promise<void> {
      return writeValues().then(() => writing);
    },
  };
}
