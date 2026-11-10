/**
 * Content search stream lifecycle (src/lib/composables/use-content-search.svelte.ts):
 * batch accumulation + dedup, superseded and cancelled searches, attribution
 * of app-wide events to the search that started them, inline (mock-mode)
 * fallback, filter/expand rebuilds, no-flicker re-search.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContentSearchEvent } from "../../src/lib/api/search";

// --- Mocks -----------------------------------------------------------------

type Handler = (event: { payload: ContentSearchEvent }) => void;

// Plays Tauri's event bus: `content-search-results` reaches every listener
// registered (by this or any other window) until its unlisten runs.
const listeners = new Set<Handler>();
const listen = vi.fn(async (_name: string, handler: Handler) => {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
});

function emit(payload: ContentSearchEvent): void {
  for (const deliver of [...listeners]) deliver({ payload });
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof listen>) => listen(...args),
}));

const startContentSearch = vi.fn();
const cancelContentSearch = vi.fn(async (_id: number) => ({ ok: true, data: undefined }));

vi.mock("$lib/api/search", () => ({
  startContentSearch: (...args: unknown[]) => startContentSearch(...args),
  cancelContentSearch: (id: number) => cancelContentSearch(id),
}));

import { useContentSearch } from "../../src/lib/composables/use-content-search.svelte";

// --- Helpers ----------------------------------------------------------------

function fileResult(path: string, lines: number[]) {
  return {
    path,
    relativePath: path.replace(/^\//, ""),
    matches: lines.map((line) => ({
      lineNumber: line,
      column: 1,
      lineContent: `line ${line}`,
      matchStart: 0,
      matchEnd: 4,
    })),
  };
}

function batch(searchId: number, results: ReturnType<typeof fileResult>[], done = false): ContentSearchEvent {
  return {
    searchId,
    results,
    done,
    filesSearched: 10,
    totalMatches: results.reduce((n, r) => n + r.matches.length, 0),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const opts = { caseSensitive: false, regexMode: false };

function okStart(searchId: number) {
  return { ok: true as const, data: { searchId, inline: null } };
}

beforeEach(() => {
  listeners.clear();
  listen.mockClear();
  startContentSearch.mockReset();
  cancelContentSearch.mockReset();
  cancelContentSearch.mockImplementation(async () => ({ ok: true, data: undefined }));
});

// --- Tests -------------------------------------------------------------------

describe("useContentSearch", () => {
  it("accumulates streamed batches and dedupes repeated paths", async () => {
    startContentSearch.mockResolvedValue(okStart(1));
    const search = useContentSearch();

    await search.start("q", "/root", { caseSensitive: false, regexMode: false });
    expect(search.loading).toBe(true);

    emit(batch(1, [fileResult("/a.ts", [1])]));
    expect(search.flattened).toHaveLength(1);

    // Second batch: one new file, one duplicate of /a.ts that must be dropped.
    emit(batch(1, [fileResult("/a.ts", [1]), fileResult("/b.ts", [2])], true));

    expect(search.fileCount).toBe(2);
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/a.ts", "/b.ts"]);
    expect(search.loading).toBe(false);
  });

  it("ignores events from a different search id once locked", async () => {
    startContentSearch.mockResolvedValue(okStart(7));
    const search = useContentSearch();
    await search.start("q", "/root", { caseSensitive: false, regexMode: false });

    emit(batch(99, [fileResult("/stale.ts", [1])]));
    expect(search.flattened).toHaveLength(0);

    emit(batch(7, [fileResult("/fresh.ts", [1])]));
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/fresh.ts"]);
  });

  it("supersedes an in-flight search and cancels its orphaned backend id", async () => {
    // First invoke hangs until after the second search claims the generation.
    let resolveFirst!: (value: ReturnType<typeof okStart>) => void;
    startContentSearch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(okStart(2));

    const search = useContentSearch();
    const first = search.start("one", "/root", { caseSensitive: false, regexMode: false });
    // Let the first search reach its (hanging) backend invoke before superseding.
    await vi.waitFor(() => expect(startContentSearch).toHaveBeenCalledTimes(1));
    await search.start("two", "/root", { caseSensitive: false, regexMode: false });

    resolveFirst(okStart(1));
    await first;

    // The first search resolved after being superseded: its backend id is
    // cancelled and results from search 2 keep flowing.
    expect(cancelContentSearch).toHaveBeenCalledWith(1);
    emit(batch(2, [fileResult("/b.ts", [1])], true));
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/b.ts"]);
  });

  it("keeps previous results visible until the new search produces data", async () => {
    startContentSearch.mockResolvedValue(okStart(1));
    const search = useContentSearch();
    await search.start("q", "/root", { caseSensitive: false, regexMode: false });
    emit(batch(1, [fileResult("/old.ts", [1])], true));
    expect(search.flattened).toHaveLength(1);

    // Re-search: until the new stream emits, the old rows must stay.
    startContentSearch.mockResolvedValue(okStart(2));
    await search.start("q2", "/root", { caseSensitive: false, regexMode: false });
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/old.ts"]);

    emit(batch(2, [fileResult("/new.ts", [1])], true));
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/new.ts"]);
  });

  it("uses inline results when streaming is unavailable (mock mode)", async () => {
    startContentSearch.mockResolvedValue({
      ok: true,
      data: { searchId: null, inline: batch(0, [fileResult("/a.ts", [1, 2])], true) },
    });
    const search = useContentSearch();

    await search.start("q", "/root", { caseSensitive: false, regexMode: false });

    expect(search.flattened).toHaveLength(2);
    expect(search.totalMatches).toBe(2);
    expect(search.loading).toBe(false);
  });

  it("clears stale rows and stops loading when the search fails", async () => {
    startContentSearch.mockResolvedValue(okStart(1));
    const search = useContentSearch();
    await search.start("q", "/root", { caseSensitive: false, regexMode: false });
    emit(batch(1, [fileResult("/a.ts", [1])], true));

    startContentSearch.mockResolvedValue({ ok: false, error: "bad pattern" });
    await search.start("(", "/root", { caseSensitive: false, regexMode: false });

    expect(search.flattened).toHaveLength(0);
    expect(search.loading).toBe(false);
  });

  it("setFilter and toggleExpanded rebuild from the full result set", async () => {
    startContentSearch.mockResolvedValue(okStart(1));
    const search = useContentSearch();
    await search.start("q", "/root", { caseSensitive: false, regexMode: false });

    // 7 matches in one file: collapsed to 5 + show-more row.
    emit(batch(1, [fileResult("/big.ts", [1, 2, 3, 4, 5, 6, 7])], true));
    expect(search.flattened).toHaveLength(6);
    expect(search.flattened.at(-1)?.isShowMore).toBe(true);

    search.toggleExpanded("/big.ts");
    expect(search.flattened).toHaveLength(7);
    expect(search.expandedFiles.has("/big.ts")).toBe(true);

    // "line 3" matches only one row's content.
    search.setFilter("line 3");
    expect(search.flattened).toHaveLength(1);
    search.setFilter("");
    expect(search.flattened).toHaveLength(7);
  });

  it("reset clears state and cancels the active backend search", async () => {
    startContentSearch.mockResolvedValue(okStart(4));
    const search = useContentSearch();
    await search.start("q", "/root", { caseSensitive: false, regexMode: false });
    emit(batch(4, [fileResult("/a.ts", [1])]));

    search.reset();

    expect(search.flattened).toHaveLength(0);
    expect(search.fileCount).toBe(0);
    expect(search.loading).toBe(false);
    await vi.waitFor(() => expect(cancelContentSearch).toHaveBeenCalledWith(4));
  });

  describe("late cancellation (#1579)", () => {
    it("a superseded search's late cancellation leaves its replacement's results flowing", async () => {
      const cancels: Array<() => void> = [];
      cancelContentSearch.mockImplementation((_id: number) => {
        const reply = deferred<{ ok: true; data: undefined }>();
        cancels.push(() => reply.resolve({ ok: true, data: undefined }));
        return reply.promise;
      });
      const search = useContentSearch();
      startContentSearch.mockResolvedValueOnce(okStart(1));
      await search.start("a", "/root", opts);

      // B cancels A; C supersedes B while that cancellation is still pending.
      // Only C reaches the backend start.
      startContentSearch.mockResolvedValueOnce(okStart(3));
      const b = search.start("ab", "/root", opts);
      await search.start("abc", "/root", opts);
      expect(cancels).toHaveLength(1);
      for (const resolve of cancels) resolve();
      await b;

      emit(batch(3, [fileResult("/c.ts", [1])], true));
      expect(search.flattened.map((r) => r.filePath)).toEqual(["/c.ts"]);
      expect(search.loading).toBe(false);
      expect(listeners.size).toBe(1);
    });

    it("a reset's late cancellation leaves the next search's results flowing", async () => {
      const cancel = deferred<{ ok: true; data: undefined }>();
      cancelContentSearch.mockImplementation(() => cancel.promise);
      const search = useContentSearch();
      startContentSearch.mockResolvedValueOnce(okStart(1));
      await search.start("a", "/root", opts);

      search.reset();
      startContentSearch.mockResolvedValueOnce(okStart(2));
      await search.start("b", "/root", opts);
      cancel.resolve({ ok: true, data: undefined });
      await new Promise((r) => setTimeout(r, 0));

      emit(batch(2, [fileResult("/b.ts", [1])], true));
      expect(search.flattened.map((r) => r.filePath)).toEqual(["/b.ts"]);
      expect(search.loading).toBe(false);
    });

    it("detaches a superseded search's listener before asking the backend to cancel it", async () => {
      const search = useContentSearch();
      startContentSearch.mockResolvedValueOnce(okStart(1));
      await search.start("a", "/root", opts);
      let attachedAtCancel = -1;
      cancelContentSearch.mockImplementation(async () => {
        attachedAtCancel = listeners.size;
        return { ok: true, data: undefined };
      });
      startContentSearch.mockResolvedValueOnce(okStart(2));
      const next = search.start("b", "/root", opts);
      expect(cancelContentSearch).toHaveBeenCalledWith(1);
      expect(attachedAtCancel).toBe(0);
      await next;
      expect(listeners.size).toBe(1);
    });

    it("releases a listener whose registration resolves after its search was superseded", async () => {
      const registration = deferred<void>();
      listen.mockImplementationOnce(async (_name: string, handler: Handler) => {
        listeners.add(handler);
        await registration.promise;
        return () => {
          listeners.delete(handler);
        };
      });
      const search = useContentSearch();
      startContentSearch.mockResolvedValue(okStart(2));
      const first = search.start("a", "/root", opts);
      await search.start("b", "/root", opts);
      registration.resolve();
      await first;

      expect(listeners.size).toBe(1);
      expect(startContentSearch).toHaveBeenCalledTimes(1);
    });
  });

  describe("stream attribution before the start IPC returns (#1581)", () => {
    it("never shows another search's events, and applies its own early batches in order", async () => {
      const reply = deferred<ReturnType<typeof okStart>>();
      startContentSearch.mockReturnValueOnce(reply.promise);
      const search = useContentSearch();
      const started = search.start("q", "/root", opts);
      await vi.waitFor(() => expect(startContentSearch).toHaveBeenCalledTimes(1));

      // Another window's search, then this search's own first batches, all
      // arrive before this window's start IPC has named its stream.
      emit(batch(77, [fileResult("/foreign.ts", [1])], true));
      emit(batch(5, [fileResult("/own-1.ts", [1])]));
      emit(batch(5, [fileResult("/own-2.ts", [1])]));
      expect(search.flattened).toHaveLength(0);
      expect(search.loading).toBe(true);

      reply.resolve(okStart(5));
      await started;
      expect(search.flattened.map((r) => r.filePath)).toEqual(["/own-1.ts", "/own-2.ts"]);
      expect(search.loading).toBe(true);

      emit(batch(77, [fileResult("/foreign-late.ts", [1])]));
      emit(batch(5, [fileResult("/own-3.ts", [1])], true));
      expect(search.flattened.map((r) => r.filePath)).toEqual(["/own-1.ts", "/own-2.ts", "/own-3.ts"]);
      expect(search.loading).toBe(false);
    });

    it("drops held events when the start IPC fails", async () => {
      const reply = deferred<{ ok: false; error: string }>();
      startContentSearch.mockReturnValueOnce(reply.promise);
      const search = useContentSearch();
      const started = search.start("q", "/root", opts);
      await vi.waitFor(() => expect(startContentSearch).toHaveBeenCalledTimes(1));
      emit(batch(9, [fileResult("/foreign.ts", [1])]));
      reply.resolve({ ok: false, error: "bad pattern" });
      await started;
      expect(search.flattened).toHaveLength(0);
      expect(search.loading).toBe(false);
    });
  });
});
