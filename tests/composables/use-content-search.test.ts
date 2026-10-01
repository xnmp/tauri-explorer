/**
 * Content search stream lifecycle (src/lib/composables/use-content-search.svelte.ts):
 * batch accumulation + dedup, generation guard for superseded searches,
 * inline (mock-mode) fallback, filter/expand rebuilds, no-flicker re-search.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContentSearchEvent } from "../../src/lib/api/search";

// --- Mocks -----------------------------------------------------------------

let eventHandler: ((event: { payload: ContentSearchEvent }) => void) | null = null;
const unlisten = vi.fn();
const listen = vi.fn(async (_name: string, handler: (event: { payload: ContentSearchEvent }) => void) => {
  eventHandler = handler;
  return unlisten;
});

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

function okStart(searchId: number) {
  return { ok: true as const, data: { searchId, inline: null } };
}

beforeEach(() => {
  eventHandler = null;
  listen.mockClear();
  unlisten.mockClear();
  startContentSearch.mockReset();
  cancelContentSearch.mockClear();
});

// --- Tests -------------------------------------------------------------------

describe("useContentSearch", () => {
  it("accumulates streamed batches and dedupes repeated paths", async () => {
    startContentSearch.mockResolvedValue(okStart(1));
    const search = useContentSearch();

    await search.start("q", "/root", { caseSensitive: false, regexMode: false });
    expect(search.loading).toBe(true);

    eventHandler!({ payload: batch(1, [fileResult("/a.ts", [1])]) });
    expect(search.flattened).toHaveLength(1);

    // Second batch: one new file, one duplicate of /a.ts that must be dropped.
    eventHandler!({
      payload: batch(1, [fileResult("/a.ts", [1]), fileResult("/b.ts", [2])], true),
    });

    expect(search.fileCount).toBe(2);
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/a.ts", "/b.ts"]);
    expect(search.loading).toBe(false);
  });

  it("ignores events from a different search id once locked", async () => {
    startContentSearch.mockResolvedValue(okStart(7));
    const search = useContentSearch();
    await search.start("q", "/root", { caseSensitive: false, regexMode: false });

    eventHandler!({ payload: batch(99, [fileResult("/stale.ts", [1])]) });
    expect(search.flattened).toHaveLength(0);

    eventHandler!({ payload: batch(7, [fileResult("/fresh.ts", [1])]) });
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
    eventHandler!({ payload: batch(2, [fileResult("/b.ts", [1])], true) });
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/b.ts"]);
  });

  it("keeps previous results visible until the new search produces data", async () => {
    startContentSearch.mockResolvedValue(okStart(1));
    const search = useContentSearch();
    await search.start("q", "/root", { caseSensitive: false, regexMode: false });
    eventHandler!({ payload: batch(1, [fileResult("/old.ts", [1])], true) });
    expect(search.flattened).toHaveLength(1);

    // Re-search: until the new stream emits, the old rows must stay.
    startContentSearch.mockResolvedValue(okStart(2));
    await search.start("q2", "/root", { caseSensitive: false, regexMode: false });
    expect(search.flattened.map((r) => r.filePath)).toEqual(["/old.ts"]);

    eventHandler!({ payload: batch(2, [fileResult("/new.ts", [1])], true) });
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
    eventHandler!({ payload: batch(1, [fileResult("/a.ts", [1])], true) });

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
    eventHandler!({
      payload: batch(1, [fileResult("/big.ts", [1, 2, 3, 4, 5, 6, 7])], true),
    });
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
    eventHandler!({ payload: batch(4, [fileResult("/a.ts", [1])]) });

    search.reset();

    expect(search.flattened).toHaveLength(0);
    expect(search.fileCount).toBe(0);
    expect(search.loading).toBe(false);
    await vi.waitFor(() => expect(cancelContentSearch).toHaveBeenCalledWith(4));
  });
});
