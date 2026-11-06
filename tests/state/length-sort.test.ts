/** Sort by Length (#1531): folder-wide, bounded, cancellable length requests. */
import { describe, expect, it, vi } from "vitest";
import { BatchedEntryResolver } from "$lib/state/batched-entry-resolver.svelte";
import { createLengthSortRequests } from "$lib/state/length-sort-requests.svelte";
import type { FileEntry } from "$lib/domain/file";

const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Deferred { entries: FileEntry[]; signal: AbortSignal; resolve: (values: unknown[]) => void }

function controlled(limits: { batchSize?: number; maxConcurrent?: number; maxEntries?: number } = {}) {
  const calls: Deferred[] = [];
  const load = vi.fn((entries: FileEntry[], signal: AbortSignal) => new Promise<readonly unknown[]>((resolve) => {
    calls.push({ entries, signal, resolve });
  }));
  const resolver = new BatchedEntryResolver<number | null>({
    load, normalize: (value) => (typeof value === "number" ? value : null), failure: null,
    eligible: (entry) => entry.name.endsWith(".mp4"), ...limits,
  });
  return { resolver, load, calls };
}

describe("BatchedEntryResolver folder-wide requests (#1531)", () => {
  it("requests every eligible entry once, in bounded batches", async () => {
    const { resolver, load, calls } = controlled({ batchSize: 4, maxConcurrent: 2 });
    const owner = {};
    const entries = [...Array.from({ length: 10 }, (_, i) => file(`/v/${i}.mp4`)), file("/v/notes.txt")];
    resolver.requestAll(entries, owner);
    resolver.requestAll(entries, owner); // a re-sync never duplicates work
    await flush();
    expect(load).toHaveBeenCalledTimes(2); // maxConcurrent
    calls.splice(0).forEach((call) => call.resolve(call.entries.map(() => 7)));
    await flush();
    calls.splice(0).forEach((call) => call.resolve(call.entries.map(() => 7)));
    await flush();
    const requested = load.mock.calls.flatMap(([batch]) => batch.map((entry) => entry.path));
    expect(requested).toHaveLength(10);
    expect(new Set(requested).size).toBe(10);
    expect(requested).not.toContain("/v/notes.txt");
    expect(load.mock.calls.every(([batch]) => batch.length <= 4)).toBe(true);
    expect(resolver.value(entries[9])).toBe(7);
  });

  it("stops at the cache capacity; the rest stay unknown", async () => {
    const { resolver, load, calls } = controlled({ batchSize: 100, maxEntries: 3 });
    const entries = Array.from({ length: 6 }, (_, i) => file(`/v/${i}.mp4`));
    resolver.requestAll(entries, {});
    await flush();
    expect(load.mock.calls.flatMap(([batch]) => batch.map((entry) => entry.name))).toEqual(["0.mp4", "1.mp4", "2.mp4"]);
    calls[0].resolve([1, 2, 3]);
    await flush();
    expect(entries.map((entry) => resolver.value(entry))).toEqual([1, 2, 3, undefined, undefined, undefined]);
  });

  it("bumps its reactive revision as values settle", async () => {
    const { resolver, calls } = controlled();
    const before = resolver.revision;
    resolver.requestAll([file("/v/a.mp4")], {});
    await flush();
    calls[0].resolve([5]);
    await flush();
    expect(resolver.revision).toBeGreaterThan(before);
  });

  it("cancel drops queued work and aborts an in-flight batch nobody else wants", async () => {
    const { resolver, load, calls } = controlled({ batchSize: 2, maxConcurrent: 1 });
    const owner = {};
    const entries = Array.from({ length: 6 }, (_, i) => file(`/v/${i}.mp4`));
    resolver.requestAll(entries, owner);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    resolver.cancel(owner);
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve([1, 2]); // a late result after abort is not a value
    await flush();
    expect(load).toHaveBeenCalledTimes(1); // queued batches never start
    expect(resolver.value(entries[0])).toBeUndefined();
    // A later request (e.g. sorting by Length again) loads afresh.
    resolver.requestAll(entries.slice(0, 1), {});
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("cancel keeps work a rendered row also wants", async () => {
    const { resolver, load, calls } = controlled({ batchSize: 2, maxConcurrent: 1 });
    const owner = {};
    const [a, b, c] = [file("/v/a.mp4"), file("/v/b.mp4"), file("/v/c.mp4")];
    resolver.requestAll([a, b, c], owner);
    resolver.request(a); // rendered row, in the in-flight batch
    resolver.request(c); // rendered row, still queued
    await flush();
    resolver.cancel(owner);
    expect(calls[0].signal.aborted).toBe(false);
    calls[0].resolve([1, 2]);
    await flush();
    expect(resolver.value(a)).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0].map((entry) => entry.name)).toEqual(["c.mp4"]);
  });

  it("dispose aborts every in-flight batch", async () => {
    const { resolver, calls } = controlled();
    resolver.requestAll([file("/v/a.mp4")], {});
    await flush();
    resolver.dispose();
    expect(calls[0].signal.aborted).toBe(true);
  });
});

describe("createLengthSortRequests (#1531)", () => {
  const source = () => ({ requestAll: vi.fn(), cancel: vi.fn() });

  it("requests the listing while active, and withdraws on leaving the Length sort", () => {
    const requests = createLengthSortRequests();
    const media = source();
    const plugin = source();
    const entries = [file("/a/x.mp4")];
    requests.sync(true, "/a", entries, [media, plugin]);
    expect(media.requestAll).toHaveBeenCalledWith(entries, expect.any(Object));
    expect(plugin.requestAll).toHaveBeenCalledWith(entries, expect.any(Object));
    const owner = media.requestAll.mock.calls[0][1];
    expect(plugin.requestAll.mock.calls[0][1]).toBe(owner);
    requests.sync(false, "/a", [], []);
    expect(media.cancel).toHaveBeenCalledWith(owner);
    expect(plugin.cancel).toHaveBeenCalledWith(owner);
  });

  it("a listing refresh re-requests without withdrawing", () => {
    const requests = createLengthSortRequests();
    const media = source();
    requests.sync(true, "/a", [file("/a/x.mp4")], [media]);
    requests.sync(true, "/a", [file("/a/x.mp4"), file("/a/y.mp4")], [media]);
    expect(media.cancel).not.toHaveBeenCalled();
    expect(media.requestAll).toHaveBeenCalledTimes(2);
    expect(media.requestAll.mock.calls[1][1]).toBe(media.requestAll.mock.calls[0][1]);
  });

  it("switching folders withdraws the old folder's requests under a fresh owner", () => {
    const requests = createLengthSortRequests();
    const media = source();
    requests.sync(true, "/a", [file("/a/x.mp4")], [media]);
    const first = media.requestAll.mock.calls[0][1];
    requests.sync(true, "/b", [file("/b/y.mp4")], [media]);
    expect(media.cancel).toHaveBeenCalledWith(first);
    const second = media.requestAll.mock.calls[1][1];
    expect(second).not.toBe(first);
    requests.dispose();
    expect(media.cancel).toHaveBeenLastCalledWith(second);
  });

  it("end to end: switching folders aborts the in-flight folder-wide batch", async () => {
    const { resolver, calls } = controlled({ batchSize: 2, maxConcurrent: 1 });
    const requests = createLengthSortRequests();
    requests.sync(true, "/a", [file("/a/1.mp4"), file("/a/2.mp4"), file("/a/3.mp4")], [resolver]);
    await flush();
    requests.sync(true, "/b", [file("/b/1.mp4")], [resolver]);
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve([1, 2]);
    await flush();
    expect(calls.slice(1).flatMap((call) => call.entries.map((entry) => entry.path))).toEqual(["/b/1.mp4"]);
  });
});
