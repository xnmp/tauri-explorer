/**
 * Streaming directory-listing lifecycle (createDirectoryListing).
 *
 * Guards the single-persistent-listener refactor (perf #10): the
 * `directory-entries` listener is registered ONCE and reused across loads,
 * instead of listen()+unlisten() per load (a second IPC hop on every nav).
 * Also covers the correctness invariants that refactor must preserve:
 * streamed chunks reach onEntries/onDone, chunks that arrive before the invoke
 * resolves are merged into the returned entries, and a superseded load is
 * cancelled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryWatchLease } from "$lib/api/files";

// ── Mocks ────────────────────────────────────────────────────────────────

type EntriesEvent = { listingId: number; entries: FileEntry[]; done: boolean };

// Capture the registered event handler and count registrations/teardowns so we
// can assert the listener is shared across loads.
const listenState = vi.hoisted(() => ({
  handler: null as ((e: { payload: EntriesEvent }) => void) | null,
  listenCalls: 0,
  unlistenCalls: 0,
  rejectNext: null as Error | null,
  deferNext: false,
  resolvePending: null as (() => void) | null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, cb: (e: { payload: EntriesEvent }) => void) => {
    listenState.listenCalls++;
    if (listenState.rejectNext) {
      const error = listenState.rejectNext;
      listenState.rejectNext = null;
      return Promise.reject(error);
    }

    const install = () => {
      listenState.handler = cb;
      return () => {
        listenState.unlistenCalls++;
        if (listenState.handler === cb) listenState.handler = null;
      };
    };

    if (listenState.deferNext) {
      listenState.deferNext = false;
      return new Promise<() => void>((resolve) => {
        listenState.resolvePending = () => resolve(install());
      });
    }

    return Promise.resolve(install());
  }),
}));

function markNativeRuntime() {
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
  });
}

async function settleMicrotasks() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

type StartResult =
  | {
      ok: true;
      data: {
        path: string;
        entries: FileEntry[];
        listing_id: number | null;
        watch_lease?: DirectoryWatchLease;
      };
    }
  | { ok: false; error: string };

const apiMocks = vi.hoisted(() => ({
  resolveStart: null as ((r: StartResult) => void) | null,
  deferCancel: false,
  resolveCancel: null as (() => void) | null,
  cancelDirectoryListing: vi.fn(() => {
    if (!apiMocks.deferCancel) return Promise.resolve();
    return new Promise<void>((resolve) => {
      apiMocks.resolveCancel = resolve;
    });
  }),
  startStreamingDirectory: vi.fn(
    () =>
      new Promise<StartResult>((resolve) => {
        apiMocks.resolveStart = resolve;
      }),
  ),
}));

vi.mock(import("../../src/lib/api/files"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    startStreamingDirectory:
      apiMocks.startStreamingDirectory as unknown as typeof actual.startStreamingDirectory,
    cancelDirectoryListing:
      apiMocks.cancelDirectoryListing as unknown as typeof actual.cancelDirectoryListing,
  };
});

import {
  createDirectoryListing,
  type DirectoryObservation,
} from "../../src/lib/state/directory-listing";

function entry(name: string): FileEntry {
  return { name, path: `/d/${name}`, kind: "file", size: 0, modified: "" };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function emit(ev: EntriesEvent) {
  listenState.handler?.({ payload: ev });
}

function observation(
  ready: Promise<void> = Promise.resolve(),
  accepted = true,
): DirectoryObservation & {
  accept: ReturnType<typeof vi.fn<DirectoryObservation["accept"]>>;
  discard: ReturnType<typeof vi.fn<DirectoryObservation["discard"]>>;
} {
  return {
    ready,
    accept: vi.fn(() => accepted),
    discard: vi.fn<DirectoryObservation["discard"]>(),
  };
}

/** Let the persistent listener's listen() promise resolve. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  listenState.handler = null;
  listenState.listenCalls = 0;
  listenState.unlistenCalls = 0;
  listenState.rejectNext = null;
  listenState.deferNext = false;
  listenState.resolvePending = null;
  apiMocks.resolveStart = null;
  apiMocks.deferCancel = false;
  apiMocks.resolveCancel = null;
  apiMocks.startStreamingDirectory.mockClear();
  apiMocks.cancelDirectoryListing.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDirectoryListing — persistent listener", () => {
  it.each(["listener", "observation"] as const)(
    "waits for both readiness owners when %s resolves first",
    async (firstReady) => {
      listenState.deferNext = true;
      const listing = createDirectoryListing();
      const observedReady = deferred<void>();
      const observed = observation(observedReady.promise);
      const load = listing.load(
        "/d",
        { onEntries: vi.fn(), onDone: vi.fn() },
        observed,
      );
      await settleMicrotasks();

      if (firstReady === "listener") listenState.resolvePending!();
      else observedReady.resolve();
      await settleMicrotasks();
      expect(apiMocks.startStreamingDirectory).not.toHaveBeenCalled();

      if (firstReady === "listener") observedReady.resolve();
      else listenState.resolvePending!();
      await settleMicrotasks();
      expect(apiMocks.startStreamingDirectory).toHaveBeenCalledExactlyOnceWith(
        "/d",
        observed,
      );

      apiMocks.resolveStart!({
        ok: true,
        data: { path: "/d", entries: [], listing_id: null },
      });
      await expect(load).resolves.toMatchObject({ ok: true, streaming: false });
      expect(observed.accept).toHaveBeenCalledExactlyOnceWith(null);
      await listing.cleanup();
    },
  );

  it("transfers the exact observation lease before publishing stream callbacks", async () => {
    const listing = createDirectoryListing();
    await settleMicrotasks();
    const lease = { id: "lease-accepted", path: "/d" };
    const observed = observation();
    const onEntries = vi.fn(() => {
      expect(observed.accept).toHaveBeenCalledExactlyOnceWith(lease);
      expect(observed.discard).not.toHaveBeenCalled();
    });
    const onDone = vi.fn();
    const load = listing.load("/d", { onEntries, onDone }, observed);
    await settleMicrotasks();

    apiMocks.resolveStart!({
      ok: true,
      data: {
        path: "/d",
        entries: [entry("first")],
        listing_id: 81,
        watch_lease: lease,
      },
    });
    await expect(load).resolves.toMatchObject({ ok: true, streaming: true });
    expect(observed.accept).toHaveBeenCalledExactlyOnceWith(lease);

    emit({ listingId: 81, entries: [entry("later")], done: true });
    expect(onEntries).toHaveBeenCalledExactlyOnceWith([entry("later")]);
    expect(onDone).toHaveBeenCalledOnce();
    await listing.cleanup();
  });

  it("discards and cancels a streamed response whose observation owner rejects transfer", async () => {
    const listing = createDirectoryListing();
    await settleMicrotasks();
    const lease = { id: "lease-stale", path: "/stale" };
    const observed = observation(Promise.resolve(), false);
    const onEntries = vi.fn();
    const onDone = vi.fn();
    const load = listing.load("/stale", { onEntries, onDone }, observed);
    await settleMicrotasks();

    apiMocks.resolveStart!({
      ok: true,
      data: {
        path: "/stale",
        entries: [entry("stale")],
        listing_id: 82,
        watch_lease: lease,
      },
    });

    await expect(load).resolves.toEqual({
      ok: false,
      error: "Directory navigation was superseded",
    });
    expect(observed.accept).toHaveBeenCalledExactlyOnceWith(lease);
    expect(observed.discard).toHaveBeenCalledExactlyOnceWith(lease);
    expect(apiMocks.cancelDirectoryListing).toHaveBeenCalledExactlyOnceWith(82);
    emit({ listingId: 82, entries: [entry("late")], done: true });
    expect(onEntries).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    await listing.cleanup();
  });

  it("discards the exact late lease and stream when cleanup seals a pending observed load", async () => {
    const listing = createDirectoryListing();
    await settleMicrotasks();
    const lease = { id: "lease-after-cleanup", path: "/d" };
    const observed = observation();
    const onEntries = vi.fn();
    const onDone = vi.fn();
    const load = listing.load("/d", { onEntries, onDone }, observed);
    await settleMicrotasks();

    const cleanup = listing.cleanup();
    apiMocks.resolveStart!({
      ok: true,
      data: {
        path: "/d",
        entries: [entry("late")],
        listing_id: 83,
        watch_lease: lease,
      },
    });

    await expect(load).resolves.toEqual({
      ok: false,
      error: "Directory listing has been destroyed",
    });
    await cleanup;
    expect(observed.accept).not.toHaveBeenCalled();
    expect(observed.discard).toHaveBeenCalledExactlyOnceWith(lease);
    expect(apiMocks.cancelDirectoryListing).toHaveBeenCalledExactlyOnceWith(83);
    expect(onEntries).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("does not invoke when observation readiness fails", async () => {
    const listing = createDirectoryListing();
    await settleMicrotasks();
    const observed = observation(Promise.reject(new Error("observation unavailable")));

    await expect(listing.load(
      "/d",
      { onEntries: vi.fn(), onDone: vi.fn() },
      observed,
    )).resolves.toEqual({ ok: false, error: "observation unavailable" });
    expect(apiMocks.startStreamingDirectory).not.toHaveBeenCalled();
    expect(observed.accept).not.toHaveBeenCalled();
    expect(observed.discard).not.toHaveBeenCalled();
    await listing.cleanup();
  });

  it("does not invoke for an observation that became stale while awaiting readiness", async () => {
    const listing = createDirectoryListing();
    await settleMicrotasks();
    const observedReady = deferred<void>();
    const observed = {
      ...observation(observedReady.promise),
      current: vi.fn(() => false),
    };
    const load = listing.load(
      "/stale",
      { onEntries: vi.fn(), onDone: vi.fn() },
      observed,
    );
    await settleMicrotasks();

    observedReady.resolve();
    await expect(load).resolves.toEqual({
      ok: false,
      error: "Directory navigation was superseded",
    });
    expect(observed.current).toHaveBeenCalledOnce();
    expect(apiMocks.startStreamingDirectory).not.toHaveBeenCalled();
    expect(observed.accept).not.toHaveBeenCalled();
    expect(observed.discard).not.toHaveBeenCalled();
    await listing.cleanup();
  });

  it("registers the listener once and reuses it across loads (no per-load listen/unlisten)", async () => {
    const listing = createDirectoryListing();
    await flush(); // eager ensureListener() resolves
    expect(listenState.listenCalls).toBe(1);

    // First load (streaming): resolve invoke with a listing id, then complete.
    const onDone1 = vi.fn();
    const load1 = listing.load("/d", { onEntries: vi.fn(), onDone: onDone1 });
    await flush();
    apiMocks.resolveStart!({ ok: true, data: { path: "/d", entries: [entry("a")], listing_id: 1 } });
    const r1 = await load1;
    expect(r1).toMatchObject({ ok: true, streaming: true });
    emit({ listingId: 1, entries: [entry("b")], done: true });
    expect(onDone1).toHaveBeenCalledOnce();

    // Second load — listener must NOT be re-registered or torn down.
    const load2 = listing.load("/d", { onEntries: vi.fn(), onDone: vi.fn() });
    await flush();
    apiMocks.resolveStart!({ ok: true, data: { path: "/d", entries: [entry("c")], listing_id: 2 } });
    await load2;

    expect(listenState.listenCalls).toBe(1); // still one
    expect(listenState.unlistenCalls).toBe(0); // never torn down between loads
  });

  it("delivers post-invoke streamed chunks via onEntries/onDone", async () => {
    const listing = createDirectoryListing();
    await flush();

    const onEntries = vi.fn();
    const onDone = vi.fn();
    const load = listing.load("/d", { onEntries, onDone });
    await flush();
    apiMocks.resolveStart!({ ok: true, data: { path: "/d", entries: [entry("a")], listing_id: 7 } });
    const res = await load;
    expect(res).toMatchObject({ ok: true, streaming: true });

    emit({ listingId: 7, entries: [entry("b"), entry("c")], done: false });
    emit({ listingId: 7, entries: [entry("d")], done: true });

    expect(onEntries).toHaveBeenCalledTimes(2);
    expect(onEntries.mock.calls[0][0]).toHaveLength(2);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("merges chunks that arrive before the invoke resolves into the returned entries", async () => {
    const listing = createDirectoryListing();
    await flush();

    const onEntries = vi.fn();
    const load = listing.load("/d", { onEntries, onDone: vi.fn() });
    await flush();

    // A chunk for this listing lands before startStreamingDirectory resolves.
    emit({ listingId: 9, entries: [entry("early")], done: false });
    apiMocks.resolveStart!({ ok: true, data: { path: "/d", entries: [entry("first")], listing_id: 9 } });
    const res = await load;

    // Early chunk is folded into the wholesale result, not emitted (callers
    // assign result.entries directly, which would clobber an onEntries push).
    expect(res).toMatchObject({ ok: true, streaming: true });
    if (res.ok) expect(res.entries.map((e) => e.name)).toEqual(["first", "early"]);
    expect(onEntries).not.toHaveBeenCalled();
  });

  it("returns non-streaming result when listing_id is null (small dir / mock mode)", async () => {
    const listing = createDirectoryListing();
    await flush();

    const load = listing.load("/d", { onEntries: vi.fn(), onDone: vi.fn() });
    await flush();
    apiMocks.resolveStart!({
      ok: true,
      data: { path: "/d", entries: [entry("a"), entry("b")], listing_id: null },
    });
    const res = await load;
    expect(res).toMatchObject({ ok: true, streaming: false });
    if (res.ok) expect(res.entries).toHaveLength(2);
  });

  it("cancels the active listing and removes the listener on cleanup()", async () => {
    const listing = createDirectoryListing();
    await flush();

    const load = listing.load("/d", { onEntries: vi.fn(), onDone: vi.fn() });
    await flush();
    apiMocks.resolveStart!({ ok: true, data: { path: "/d", entries: [], listing_id: 3 } });
    await load;

    await listing.cleanup();
    expect(apiMocks.cancelDirectoryListing).toHaveBeenCalledWith(3);
    expect(listenState.unlistenCalls).toBe(1);
  });

  it.each([false, true])("seals active-stream teardown (inside entry callback: %s)", async (fromCallback) => {
    const listing = createDirectoryListing();
    let cleanup: Promise<void> | undefined;
    const onEntries = vi.fn(() => {
      if (fromCallback) cleanup = listing.cleanup();
    });
    const onDone = vi.fn();
    const onCancelled = vi.fn();
    const load = listing.load("/d", { onEntries, onDone, onCancelled });
    await flush();
    apiMocks.resolveStart!({ ok: true, data: { path: "/d", entries: [], listing_id: 61 } });
    await load;

    if (!fromCallback) cleanup = listing.cleanup();
    // Delivery can precede the queued teardown's first microtask.
    emit({ listingId: 61, entries: [entry("after-cleanup")], done: true });
    await cleanup;
    await listing.cleanup();

    expect(onEntries).toHaveBeenCalledTimes(fromCallback ? 1 : 0);
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(apiMocks.cancelDirectoryListing).toHaveBeenCalledExactlyOnceWith(61);
    expect(listenState.unlistenCalls).toBe(1);
  });

  it("does not start a native stream when listener registration fails and retries on the next load", async () => {
    markNativeRuntime();
    listenState.rejectNext = new Error("listener unavailable");
    const listing = createDirectoryListing();

    const firstLoad = listing.load("/d", { onEntries: vi.fn(), onDone: vi.fn() });
    await settleMicrotasks();
    apiMocks.resolveStart?.({
      ok: true,
      data: { path: "/d", entries: [], listing_id: null },
    });
    const first = await firstLoad;

    expect(first).toEqual({ ok: false, error: "listener unavailable" });
    expect(apiMocks.startStreamingDirectory).not.toHaveBeenCalled();

    const onEntries = vi.fn();
    const onDone = vi.fn();
    const retry = listing.load("/d", { onEntries, onDone });
    await settleMicrotasks();
    apiMocks.resolveStart!({
      ok: true,
      data: { path: "/d", entries: [entry("first")], listing_id: 41 },
    });

    const result = await retry;
    expect(result).toMatchObject({ ok: true, streaming: true });
    emit({ listingId: 41, entries: [entry("later")], done: true });
    expect(onEntries).toHaveBeenCalledWith([entry("later")]);
    expect(onDone).toHaveBeenCalledOnce();
    expect(listenState.listenCalls).toBe(2);
    expect(apiMocks.startStreamingDirectory).toHaveBeenCalledOnce();
  });

  it("releases a listener that resolves after teardown starts during a retry", async () => {
    markNativeRuntime();
    listenState.rejectNext = new Error("listener unavailable");
    const listing = createDirectoryListing();
    const firstLoad = listing.load("/d", { onEntries: vi.fn(), onDone: vi.fn() });
    await settleMicrotasks();
    apiMocks.resolveStart?.({
      ok: true,
      data: { path: "/d", entries: [], listing_id: null },
    });
    await firstLoad;

    listenState.deferNext = true;
    const retry = listing.load("/d", { onEntries: vi.fn(), onDone: vi.fn() });
    await settleMicrotasks();
    expect(listenState.resolvePending).not.toBeNull();

    const cleanup = listing.cleanup();
    listenState.resolvePending!();

    await expect(retry).resolves.toEqual({
      ok: false,
      error: "Directory listing has been destroyed",
    });
    await cleanup;
    expect(apiMocks.startStreamingDirectory).not.toHaveBeenCalled();
    expect(listenState.unlistenCalls).toBe(1);
    expect(listenState.handler).toBeNull();
  });

  it("rejects an inline listing that resolves after cleanup seals its owner", async () => {
    const listing = createDirectoryListing();
    await settleMicrotasks();
    const onEntries = vi.fn();
    const onDone = vi.fn();
    const onCancelled = vi.fn();
    const load = listing.load("/d", { onEntries, onDone, onCancelled });
    await settleMicrotasks();

    const cleanup = listing.cleanup();
    emit({ listingId: 61, entries: [entry("during-teardown")], done: true });
    apiMocks.resolveStart!({
      ok: true,
      data: { path: "/d", entries: [entry("late-inline")], listing_id: null },
    });

    await expect(load).resolves.toEqual({
      ok: false,
      error: "Directory listing has been destroyed",
    });
    await cleanup;
    expect(apiMocks.cancelDirectoryListing).not.toHaveBeenCalled();
    expect(onEntries).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("cancels one late stream and ignores events while teardown is pending", async () => {
    const listing = createDirectoryListing();
    await settleMicrotasks();
    const onEntries = vi.fn();
    const onDone = vi.fn();
    const onCancelled = vi.fn();
    const load = listing.load("/d", { onEntries, onDone, onCancelled });
    await settleMicrotasks();

    apiMocks.deferCancel = true;
    const cleanup = listing.cleanup();
    emit({ listingId: 62, entries: [entry("buffered-after-cleanup")], done: false });
    apiMocks.resolveStart!({
      ok: true,
      data: { path: "/d", entries: [entry("late-first")], listing_id: 62 },
    });
    await settleMicrotasks();

    expect(apiMocks.cancelDirectoryListing).toHaveBeenCalledOnce();
    expect(apiMocks.cancelDirectoryListing).toHaveBeenCalledWith(62);
    emit({ listingId: 62, entries: [entry("during-cancel")], done: true });
    expect(onEntries).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();

    apiMocks.resolveCancel!();
    await expect(load).resolves.toEqual({
      ok: false,
      error: "Directory listing has been destroyed",
    });
    await cleanup;
    expect(apiMocks.cancelDirectoryListing).toHaveBeenCalledOnce();
    expect(onEntries).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
  });
});
