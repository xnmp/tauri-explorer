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

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry } from "$lib/domain/file";

// ── Mocks ────────────────────────────────────────────────────────────────

type EntriesEvent = { listingId: number; entries: FileEntry[]; done: boolean };

// Capture the registered event handler and count registrations/teardowns so we
// can assert the listener is shared across loads.
const listenState = vi.hoisted(() => ({
  handler: null as ((e: { payload: EntriesEvent }) => void) | null,
  listenCalls: 0,
  unlistenCalls: 0,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: EntriesEvent }) => void) => {
    listenState.listenCalls++;
    listenState.handler = cb;
    return () => {
      listenState.unlistenCalls++;
      listenState.handler = null;
    };
  }),
}));

type StartResult =
  | { ok: true; data: { path: string; entries: FileEntry[]; listing_id: number | null } }
  | { ok: false; error: string };

const apiMocks = vi.hoisted(() => ({
  resolveStart: null as ((r: StartResult) => void) | null,
  cancelDirectoryListing: vi.fn(async () => {}),
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

import { createDirectoryListing } from "../../src/lib/state/directory-listing";

function entry(name: string): FileEntry {
  return { name, path: `/d/${name}`, kind: "file", size: 0, modified: "" };
}

function emit(ev: EntriesEvent) {
  listenState.handler?.({ payload: ev });
}

/** Let the persistent listener's listen() promise resolve. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  listenState.handler = null;
  listenState.listenCalls = 0;
  listenState.unlistenCalls = 0;
  apiMocks.resolveStart = null;
  apiMocks.startStreamingDirectory.mockClear();
  apiMocks.cancelDirectoryListing.mockClear();
});

describe("createDirectoryListing — persistent listener", () => {
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
});
