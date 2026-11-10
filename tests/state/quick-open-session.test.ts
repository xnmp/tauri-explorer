import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { SearchResult } from "$lib/domain/search";
import {
  createQuickOpenSession,
  type QuickOpenSessionDeps,
  type QuickOpenStreamEvent,
} from "$lib/state/quick-open-session.svelte";

/**
 * Quick Open session lifecycle (#1577). The harness plays the Tauri side: a
 * registered listener receives app-wide `search-results` events until its
 * unlisten runs, and every IPC promise is resolved by the test so each
 * interleaving can be driven explicitly. `log` records the ordered side
 * effects the CLAUDE.md ordering rules talk about.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const hit = (name: string, score = 50, kind: SearchResult["kind"] = "file"): SearchResult => ({
  name,
  path: `/root/${name}`,
  relativePath: name,
  score,
  kind,
});

const names = (rows: readonly SearchResult[]) => rows.map((r) => r.name);

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

type ListenMode = "auto" | "manual" | "reject";

function harness({ listenMode = "auto" as ListenMode } = {}) {
  const log: string[] = [];
  let nextListener = 0;
  const attached = new Map<number, (event: QuickOpenStreamEvent) => void>();
  const pendingListens: Array<{ id: number; deferred: Deferred<() => void> }> = [];
  const starts: Array<{ query: string; root: string; limit: number; reply: Deferred<ApiResult<number>> }> = [];
  const fallbacks: Array<{ query: string; root: string; limit: number; reply: Deferred<ApiResult<SearchResult[]>> }> = [];
  const cancelReplies: Deferred<void>[] = [];
  let root = "/root";
  let localRows: (query: string) => SearchResult[] = (query) => [hit(`${query}-local`, 10)];
  const onBackendResults = vi.fn();
  const localMatches = vi.fn((query: string) => localRows(query));

  const deps: QuickOpenSessionDeps = {
    listen(onEvent) {
      const id = ++nextListener;
      log.push(`listen:${id}`);
      if (listenMode === "reject") return Promise.reject(new Error("no Tauri event system"));
      // Tauri registers the callback before the promise resolves in JS.
      attached.set(id, onEvent);
      const unlisten = () => {
        log.push(`unlisten:${id}`);
        attached.delete(id);
      };
      if (listenMode === "auto") return Promise.resolve(unlisten);
      const pending = deferred<() => void>();
      pendingListens.push({ id, deferred: pending });
      return pending.promise.then(() => unlisten);
    },
    startStream(query, searchRoot, limit) {
      log.push(`start:${query}`);
      const reply = deferred<ApiResult<number>>();
      starts.push({ query, root: searchRoot, limit, reply });
      return reply.promise;
    },
    cancelStream(searchId) {
      log.push(`cancel:${searchId}`);
      const reply = deferred<void>();
      cancelReplies.push(reply);
      return reply.promise;
    },
    fallbackSearch(query, searchRoot, limit) {
      log.push(`fallback:${query}`);
      const reply = deferred<ApiResult<SearchResult[]>>();
      fallbacks.push({ query, root: searchRoot, limit, reply });
      return reply.promise;
    },
    localMatches,
    rankBackend: (raw) => raw.map((r) => ({ ...r, score: r.score + 1 })),
    searchRoot: () => root,
    onBackendResults,
  };

  const session = createQuickOpenSession(deps);

  return {
    session,
    log,
    starts,
    fallbacks,
    cancelReplies,
    pendingListens,
    onBackendResults,
    localMatches,
    setRoot(next: string) {
      root = next;
    },
    setLocal(next: (query: string) => SearchResult[]) {
      localRows = next;
    },
    /** App-wide emit: every listener still registered receives it. */
    emit(event: Partial<QuickOpenStreamEvent> & { searchId: number }) {
      const payload: QuickOpenStreamEvent = { results: [], done: false, totalScanned: 0, ...event };
      for (const deliver of [...attached.values()]) deliver(payload);
    },
    /** Deliver to one registered listener only (a late event for its own search). */
    emitTo(listenerId: number, event: Partial<QuickOpenStreamEvent> & { searchId: number }) {
      attached.get(listenerId)?.({ results: [], done: false, totalScanned: 0, ...event });
    },
    attachedCount: () => attached.size,
    /** Type, wait out the debounce and let the listener attach. */
    async startStreamFor(query: string) {
      session.input(query);
      await vi.advanceTimersByTimeAsync(150);
      await flush();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Quick Open session: input and debounce", () => {
  it("shows local matches synchronously and starts one stream for the final query of a burst", async () => {
    const h = harness();
    h.session.input("c");
    expect(names(h.session.results)).toEqual(["c-local"]);
    expect(h.session.loading).toBe(true);
    vi.advanceTimersByTime(40);
    h.session.input("ca");
    vi.advanceTimersByTime(40);
    h.session.input("capture");
    expect(names(h.session.results)).toEqual(["capture-local"]);

    await vi.advanceTimersByTimeAsync(149);
    expect(h.log).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.starts.map((s) => s.query)).toEqual(["capture"]);
    expect(h.log).toEqual(["listen:1", "start:capture"]);
  });

  it("never lets local matches wait on the backend", async () => {
    const h = harness();
    await h.startStreamFor("doc");
    // The start IPC is still pending; new input still renders immediately.
    h.session.input("docs");
    expect(names(h.session.results)).toEqual(["docs-local"]);
  });

  it("caps local matches at the result limit", () => {
    const h = harness();
    h.setLocal((q) => Array.from({ length: 500 }, (_, i) => hit(`${q}${i}`, i)));
    h.session.input("f");
    expect(h.session.results).toHaveLength(20);
    expect(h.session.results[0].name).toBe("f499");
  });

  it("pins the selection to the top result on every new query", () => {
    const h = harness();
    h.setLocal((q) => [hit(`${q}1`, 3), hit(`${q}2`, 2), hit(`${q}3`, 1)]);
    h.session.input("a");
    h.session.selectedIndex = 2;
    h.session.input("ab");
    expect(h.session.selectedIndex).toBe(0);
  });

  it("clears everything for a blank query and never searches it", async () => {
    const h = harness();
    h.session.input("abc");
    h.session.input("   ");
    expect(h.session.results).toEqual([]);
    expect(h.session.loading).toBe(false);
    expect(h.session.selectedIndex).toBe(0);
    expect(h.localMatches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.log).toEqual([]);
  });

  it("republishes local matches and reads the search root when the debounce fires", async () => {
    const h = harness();
    h.session.input("src");
    // The pane finished loading / another pane became active during the pause.
    h.setLocal((q) => [hit(`${q}-fresh`, 10)]);
    h.setRoot("/other");
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    expect(names(h.session.results)).toEqual(["src-fresh"]);
    expect(h.starts[0]).toMatchObject({ query: "src", root: "/other", limit: 20 });
  });

  it("keeps the query untrimmed for the backend and ranking", async () => {
    const h = harness();
    await h.startStreamFor("doc ");
    expect(h.starts[0].query).toBe("doc ");
    expect(h.session.query).toBe("doc ");
  });
});

describe("Quick Open session: stream lifecycle", () => {
  it("registers the listener before invoking the start IPC", async () => {
    const h = harness({ listenMode: "manual" });
    h.session.input("x");
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    expect(h.log).toEqual(["listen:1"]);
    h.pendingListens[0].deferred.resolve(() => {});
    await flush();
    expect(h.log).toEqual(["listen:1", "start:x"]);
  });

  it("never adopts another window's search before its own start IPC names the stream (#1581)", async () => {
    const h = harness();
    await h.startStreamFor("rep");
    // `search-results` reaches every window: the first event here is another
    // window's search, then this run's own first snapshots arrive, all before
    // this window's start IPC has returned.
    h.emit({ searchId: 8, results: [hit("intruder", 99)], done: true, totalScanned: 500 });
    h.emit({ searchId: 7, results: [hit("report", 60)], totalScanned: 12 });
    h.emit({ searchId: 7, results: [hit("report", 60), hit("rep.md", 58)], totalScanned: 20 });
    expect(names(h.session.results)).toEqual(["rep-local"]);
    expect(h.session.loading).toBe(true);
    expect(h.onBackendResults).not.toHaveBeenCalled();

    // Its id arrives: only its own latest snapshot is shown.
    h.starts[0].reply.resolve({ ok: true, data: 7 });
    await flush();
    expect(names(h.session.results)).toEqual(["report", "rep.md", "rep-local"]);
    expect(h.session.totalScanned).toBe(20);
    expect(h.session.loading).toBe(true);
    expect(h.onBackendResults).toHaveBeenCalledTimes(1);

    h.emit({ searchId: 8, results: [hit("intruder", 99)] });
    h.emit({ searchId: 7, results: [hit("report", 60), hit("repo", 55)], done: true, totalScanned: 40 });
    expect(names(h.session.results)).toEqual(["report", "repo", "rep-local"]);
    expect(h.session.loading).toBe(false);
    expect(h.session.totalScanned).toBe(40);
  });

  it("settles on a done snapshot that arrived before the start IPC returned", async () => {
    const h = harness();
    await h.startStreamFor("rep");
    h.emit({ searchId: 7, results: [hit("report", 60)], done: true, totalScanned: 3 });
    expect(h.session.loading).toBe(true);
    h.starts[0].reply.resolve({ ok: true, data: 7 });
    await flush();
    expect(names(h.session.results)).toEqual(["report", "rep-local"]);
    expect(h.session.loading).toBe(false);
  });

  it("drops held events when the start IPC fails", async () => {
    const h = harness();
    await h.startStreamFor("rep");
    h.emit({ searchId: 8, results: [hit("intruder", 99)] });
    h.starts[0].reply.resolve({ ok: false, error: "boom" });
    await flush();
    expect(names(h.session.results)).toEqual(["rep-local"]);
    expect(h.session.loading).toBe(false);
  });

  it("replaces rows per batch, merges local matches without duplicates and caps the list", async () => {
    const h = harness();
    h.setLocal(() => [{ ...hit("dup", 1) }, hit("only-local", 5)]);
    await h.startStreamFor("q");
    h.starts[0].reply.resolve({ ok: true, data: 1 });
    await flush();
    const many = Array.from({ length: 30 }, (_, i) => hit(`b${i}`, 100 - i));
    h.emit({ searchId: 1, results: [hit("dup", 200), ...many] });
    expect(h.session.results).toHaveLength(20);
    expect(h.session.results[0]).toMatchObject({ name: "dup", score: 201 });
    expect(h.session.results.filter((r) => r.name === "dup")).toHaveLength(1);
  });

  it("clamps the selection when a batch shrinks the list", async () => {
    const h = harness();
    h.setLocal(() => []);
    await h.startStreamFor("q");
    h.starts[0].reply.resolve({ ok: true, data: 1 });
    await flush();
    h.emit({ searchId: 1, results: [hit("a"), hit("b"), hit("c")] });
    h.session.selectedIndex = 2;
    h.emit({ searchId: 1, results: [hit("a")] });
    expect(h.session.selectedIndex).toBe(0);
  });

  it("stops loading but keeps the listener when the start IPC fails", async () => {
    const h = harness();
    await h.startStreamFor("q");
    h.starts[0].reply.resolve({ ok: false, error: "boom" });
    await flush();
    expect(h.session.loading).toBe(false);
    expect(names(h.session.results)).toEqual(["q-local"]);
    // The listener is released (without a cancel IPC — there is no id) when the run is left.
    h.session.input("qq");
    expect(h.log).toEqual(["listen:1", "start:q", "unlisten:1"]);
  });

  it("falls back to the one-shot search where events are unavailable", async () => {
    const h = harness({ listenMode: "reject" });
    h.setRoot("/pane");
    await h.startStreamFor("comp");
    expect(h.fallbacks[0]).toMatchObject({ query: "comp", root: "/pane", limit: 20 });
    expect(h.session.loading).toBe(true);
    h.fallbacks[0].reply.resolve({ ok: true, data: [hit("components", 80, "directory")] });
    await flush();
    expect(names(h.session.results)).toEqual(["components", "comp-local"]);
    expect(h.session.loading).toBe(false);
    expect(h.onBackendResults).toHaveBeenCalledTimes(1);
  });

  it("keeps local matches when the fallback search fails", async () => {
    const h = harness({ listenMode: "reject" });
    await h.startStreamFor("comp");
    h.fallbacks[0].reply.resolve({ ok: false, error: "nope" });
    await flush();
    expect(names(h.session.results)).toEqual(["comp-local"]);
    expect(h.session.loading).toBe(false);
  });

  it("ignores a fallback result that arrives after new input", async () => {
    const h = harness({ listenMode: "reject" });
    await h.startStreamFor("old");
    h.session.input("new");
    h.fallbacks[0].reply.resolve({ ok: true, data: [hit("stale", 999)] });
    await flush();
    expect(names(h.session.results)).toEqual(["new-local"]);
    expect(h.session.loading).toBe(true);
  });

  it("re-ranks the current backend hits for a downvote and ignores an empty query", async () => {
    const h = harness();
    await h.startStreamFor("q");
    h.starts[0].reply.resolve({ ok: true, data: 1 });
    await flush();
    h.emit({ searchId: 1, results: [hit("a", 50), hit("b", 40)] });
    h.setLocal(() => [hit("promoted", 500)]);
    h.session.rerank();
    expect(names(h.session.results)).toEqual(["promoted", "a", "b"]);
    // The backend score is re-derived from the raw hit, not compounded.
    expect(h.session.results[1].score).toBe(51);

    h.session.input("");
    h.session.rerank();
    expect(h.session.results).toEqual([]);
  });
});

describe("Quick Open session: supersession and cancellation", () => {
  it("detaches the listener synchronously before requesting backend cancellation", async () => {
    const h = harness();
    await h.startStreamFor("a");
    h.starts[0].reply.resolve({ ok: true, data: 1 });
    await flush();
    h.session.input("ab");
    expect(h.log.slice(-2)).toEqual(["unlisten:1", "cancel:1"]);
    expect(h.attachedCount()).toBe(0);
  });

  it("keeps the replacement listener when the earlier cancellation resolves late", async () => {
    const h = harness();
    await h.startStreamFor("first");
    h.starts[0].reply.resolve({ ok: true, data: 1 });
    await flush();
    // The cancellation IPC for search 1 stays pending across the next stream.
    await h.startStreamFor("second");
    h.starts[1].reply.resolve({ ok: true, data: 2 });
    await flush();
    h.cancelReplies[0].resolve();
    await flush();

    expect(h.attachedCount()).toBe(1);
    h.emit({ searchId: 2, results: [hit("final recursive result", 70)] });
    expect(names(h.session.results)).toContain("final recursive result");
  });

  it("does not deliver late batch or done events of a superseded stream", async () => {
    const h = harness({ listenMode: "manual" });
    h.session.input("old");
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    // The old listener is registered on the Tauri side but its promise has
    // not resolved when new input arrives.
    h.session.input("new");
    h.emit({ searchId: 1, results: [hit("stale", 999)], done: true, totalScanned: 5 });
    expect(names(h.session.results)).toEqual(["new-local"]);
    expect(h.session.loading).toBe(true);
    expect(h.session.totalScanned).toBe(0);

    // When the stale registration resolves it is released at once and never starts.
    h.pendingListens[0].deferred.resolve(() => {});
    await flush();
    expect(h.log).toEqual(["listen:1", "unlisten:1"]);
  });

  it("ignores a superseded listener's events while the new run has not learned its id", async () => {
    const h = harness({ listenMode: "manual" });
    await h.startStreamFor("old");
    h.session.input("new");
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    h.pendingListens[1].deferred.resolve(() => {});
    await flush();
    expect(h.starts.map((s) => s.query)).toEqual(["new"]);

    // Listener 1 is still registered on the Tauri side (its registration has
    // not resolved); a late batch for the old search must not be adopted.
    h.emitTo(1, { searchId: 1, results: [hit("stale", 999)], done: true, totalScanned: 5 });
    expect(names(h.session.results)).toEqual(["new-local"]);
    expect(h.session.loading).toBe(true);

    h.emitTo(2, { searchId: 2, results: [hit("fresh", 5)] });
    h.starts[0].reply.resolve({ ok: true, data: 2 });
    await flush();
    expect(names(h.session.results)).toEqual(["new-local", "fresh"]);
  });

  it("cancels an orphaned backend search whose start resolves after new input", async () => {
    const h = harness();
    await h.startStreamFor("old");
    h.session.input("new");
    h.starts[0].reply.resolve({ ok: true, data: 41 });
    await flush();
    expect(h.log).toEqual(["listen:1", "start:old", "unlisten:1", "cancel:41"]);
    expect(names(h.session.results)).toEqual(["new-local"]);
    expect(h.session.loading).toBe(true);
  });

  it("does not leave loading stuck when a superseded start fails", async () => {
    const h = harness();
    await h.startStreamFor("old");
    h.session.input("new");
    h.starts[0].reply.resolve({ ok: false, error: "late failure" });
    await flush();
    // Still loading for "new" (its debounce is pending), then settles normally.
    expect(h.session.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    h.starts[1].reply.resolve({ ok: true, data: 2 });
    await flush();
    h.emit({ searchId: 2, results: [hit("newer", 5)], done: true });
    expect(h.session.loading).toBe(false);

    const blank = harness();
    await blank.startStreamFor("old");
    blank.session.input("");
    blank.starts[0].reply.resolve({ ok: false, error: "late failure" });
    await flush();
    expect(blank.session.loading).toBe(false);
  });

  it("supersedes input that arrives while a stream is starting", async () => {
    const h = harness({ listenMode: "manual" });
    await h.startStreamFor("a");
    h.session.input("ab");
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    expect(h.log).toEqual(["listen:1", "listen:2"]);
    h.pendingListens[1].deferred.resolve(() => {});
    h.pendingListens[0].deferred.resolve(() => {});
    await flush();
    expect([...h.log].sort()).toEqual(["listen:1", "listen:2", "start:ab", "unlisten:1"]);
    expect(h.starts.map((s) => s.query)).toEqual(["ab"]);
    expect(h.attachedCount()).toBe(1);
  });
});

describe("Quick Open session: open and close", () => {
  it("close during the debounce stops the search and loading", async () => {
    const h = harness();
    h.session.input("doc");
    h.session.close();
    expect(h.session.loading).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.log).toEqual([]);
  });

  it("close while the listener registers releases it on arrival without starting", async () => {
    const h = harness({ listenMode: "manual" });
    await h.startStreamFor("doc");
    h.session.close();
    expect(h.session.loading).toBe(false);
    h.pendingListens[0].deferred.resolve(() => {});
    await flush();
    expect(h.log).toEqual(["listen:1", "unlisten:1"]);
  });

  it("close while the start IPC is pending cancels the backend search once its id arrives", async () => {
    const h = harness();
    await h.startStreamFor("doc");
    h.session.close();
    expect(h.log).toEqual(["listen:1", "start:doc", "unlisten:1"]);
    h.starts[0].reply.resolve({ ok: true, data: 9 });
    await flush();
    expect(h.log.at(-1)).toBe("cancel:9");
    expect(h.session.loading).toBe(false);
  });

  it("close during streaming detaches, cancels and resets the scanned count", async () => {
    const h = harness();
    await h.startStreamFor("doc");
    h.starts[0].reply.resolve({ ok: true, data: 3 });
    await flush();
    h.emit({ searchId: 3, results: [hit("docs")], totalScanned: 100 });
    h.session.close();
    expect(h.log.slice(-2)).toEqual(["unlisten:1", "cancel:3"]);
    expect(h.session.totalScanned).toBe(0);
    expect(h.session.loading).toBe(false);
  });

  it("reopening right after close starts empty and ignores the old stream", async () => {
    const h = harness({ listenMode: "manual" });
    await h.startStreamFor("doc");
    h.session.close();
    h.session.open();
    expect(h.session.query).toBe("");
    expect(h.session.results).toEqual([]);
    expect(h.session.loading).toBe(false);
    expect(h.session.selectedIndex).toBe(0);

    // The old run's listener was registered on the Tauri side; nothing it
    // receives may reach the reopened dialog.
    h.emit({ searchId: 1, results: [hit("stale")], done: true, totalScanned: 9 });
    h.pendingListens[0].deferred.resolve(() => {});
    await flush();
    expect(h.session.results).toEqual([]);
    expect(h.session.totalScanned).toBe(0);
    expect(h.starts).toEqual([]);

    // The reopened dialog searches normally.
    h.session.input("new");
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    h.pendingListens[1].deferred.resolve(() => {});
    await flush();
    expect(h.starts.map((s) => s.query)).toEqual(["new"]);
  });

  it("open discards a stale query, rows and selection", async () => {
    const h = harness();
    h.setLocal(() => [hit("a", 3), hit("b", 2)]);
    h.session.input("q");
    h.session.selectedIndex = 1;
    h.session.close();
    h.session.open();
    expect(h.session.query).toBe("");
    expect(h.session.results).toEqual([]);
    expect(h.session.selectedIndex).toBe(0);
  });
});
