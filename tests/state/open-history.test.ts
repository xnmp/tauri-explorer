/** Open history store (#1525): success-only recording through the launch seam,
 * lazy tolerant loading, coalesced saves and cross-window publication. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("$lib/api/common", async (original) => ({ ...await original<typeof import("$lib/api/common")>(), invoke }));

import { createOpenHistoryStore } from "$lib/state/open-history.svelte";
import { openFile, openFileAtLine, openFileWith, openFileWithApplication, openImageWithSiblings } from "$lib/api/open";
import { openHistoryStore } from "$lib/state/open-history.svelte";
import { openHistory } from "$lib/state/open-history-access.svelte";
import { parseOpenHistory, serializeOpenHistory } from "$lib/domain/open-history";

function disk(initial = "") {
  let stored = initial;
  return {
    read: vi.fn(async () => ({ ok: true as const, data: stored })),
    write: vi.fn(async (data: string) => { stored = data; return { ok: true as const, data: undefined }; }),
    get stored() { return stored; },
    set stored(value: string) { stored = value; },
  };
}

/** Two windows' BroadcastChannels, delivering synchronously. */
function linkedChannels() {
  type End = { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null };
  const a: End = { postMessage: (data) => b.onmessage?.({ data }), onmessage: null };
  const b: End = { postMessage: (data) => a.onmessage?.({ data }), onmessage: null };
  return [a, b] as const;
}

beforeEach(() => { vi.useFakeTimers(); invoke.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("open history store", () => {
  it("loads lazily and treats a corrupt document as empty", async () => {
    const store = disk("{not json");
    const history = createOpenHistoryStore(store);
    expect(store.read).not.toHaveBeenCalled();
    expect(history.lastOpened("/a")).toBeUndefined();
    await history.ensureLoaded();
    expect(store.read).toHaveBeenCalledOnce();
    expect(history.lastOpened("/a")).toBeUndefined();
  });

  it("treats a failed read as empty instead of failing", async () => {
    const history = createOpenHistoryStore({ read: async () => { throw new Error("boom"); }, write: disk().write });
    await expect(history.ensureLoaded()).resolves.toBeUndefined();
    expect(history.lastOpened("/a")).toBeUndefined();
  });

  it("coalesces a burst of opens into one save that keeps stored entries", async () => {
    const store = disk(serializeOpenHistory(new Map([["/old", 1]])));
    const history = createOpenHistoryStore({ ...store, saveDelayMs: 100 });
    history.record("/a", 10);
    history.record("/b", 20);
    history.record("/c", 30);
    expect(store.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.write).toHaveBeenCalledOnce();
    expect(Object.fromEntries(parseOpenHistory(store.stored))).toEqual({ "/old": 1, "/a": 10, "/b": 20, "/c": 30 });
    expect(history.lastOpened("/old")).toBe(1);
  });

  it("does not let a stale stored copy resurrect a forgotten path or drop another window's open", async () => {
    const store = disk(serializeOpenHistory(new Map([["/gone", 1]])));
    const history = createOpenHistoryStore({ ...store, saveDelayMs: 10 });
    await history.ensureLoaded();
    // Another process saves an open after this window loaded.
    store.stored = serializeOpenHistory(new Map([["/gone", 1], ["/elsewhere", 7]]));
    history.forget(["/gone"]);
    await history.flush();
    expect(Object.fromEntries(parseOpenHistory(store.stored))).toEqual({ "/elsewhere": 7 });
    expect(history.lastOpened("/elsewhere")).toBe(7);
  });

  it("publishes changes to other windows, which apply but do not save them", async () => {
    const [left, right] = linkedChannels();
    const store = disk();
    const a = createOpenHistoryStore({ ...store, channel: left, saveDelayMs: 10 });
    const b = createOpenHistoryStore({ ...store, channel: right, saveDelayMs: 10 });
    a.record("/x", 5);
    expect(b.lastOpened("/x")).toBe(5);
    a.move("/x", "/y");
    expect(b.lastOpened("/y")).toBe(5);
    a.forget(["/y"]);
    expect(b.lastOpened("/y")).toBeUndefined();
    right.onmessage?.({ data: { type: "open", path: 5 } }); // malformed: ignored
    await vi.advanceTimersByTimeAsync(10);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it("does not write on flush without changes of its own", async () => {
    const store = disk();
    const history = createOpenHistoryStore(store);
    await history.flush();
    expect(store.write).not.toHaveBeenCalled();
  });
});

describe("recording seam", () => {
  const launches: [string, () => Promise<{ ok: boolean }>][] = [
    ["openFile", () => openFile("/seam/a.txt")],
    ["openFileWith", () => openFileWith("/seam/a.txt", "gedit")],
    ["openFileWithApplication", () => openFileWithApplication("/seam/a.txt", "app.desktop")],
    ["openFileAtLine", () => openFileAtLine("/seam/a.txt", 3)],
    ["openImageWithSiblings", () => openImageWithSiblings("/seam/a.txt")],
  ];

  it.each(launches)("%s records only a successful launch", async (_name, launch) => {
    openHistoryStore.forget(["/seam"]);
    invoke.mockRejectedValueOnce(new Error("no handler"));
    expect((await launch()).ok).toBe(false);
    await openHistory();
    expect(openHistoryStore.lastOpened("/seam/a.txt")).toBeUndefined();
    invoke.mockResolvedValue(undefined);
    vi.setSystemTime(1_800_000_000_000);
    expect((await launch()).ok).toBe(true);
    await openHistory();
    expect(openHistoryStore.lastOpened("/seam/a.txt")).toBe(1_800_000_000_000);
  });
});
