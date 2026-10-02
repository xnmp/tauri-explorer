import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservedDirectoryListing } from "$lib/api/files";
import type { ApiResult } from "$lib/api/common";
import type { FileEntry } from "$lib/domain/file";
import { createDirectoryListing, type DirectoryObservation } from "$lib/state/directory-listing";

const { loadDirectory } = vi.hoisted(() => ({ loadDirectory: vi.fn() }));
vi.mock("$lib/api/files", () => ({ loadDirectory }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const entry = (name: string): FileEntry => ({ name, path: `/d/${name}`, kind: "file", size: 0, modified: "" });
const snapshot = (entries: FileEntry[] = []): ApiResult<ObservedDirectoryListing> => ({ ok: true, data: { path: "/d", entries } });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const observation = (ready = Promise.resolve(), accepted = true): DirectoryObservation => ({
  ready, accept: vi.fn(() => accepted), discard: vi.fn(),
});

beforeEach(() => { loadDirectory.mockReset(); });

describe("complete directory listing ownership", () => {
  it.each([0, 1, 100, 10_003])("publishes all %i entries in the single result", async (count) => {
    const entries = Array.from({ length: count }, (_, n) => entry(String(n)));
    loadDirectory.mockResolvedValue(snapshot(entries));
    const listing = createDirectoryListing();
    await expect(listing.load("/d")).resolves.toEqual({ ok: true, path: "/d", entries });
    await listing.cleanup();
  });

  it("waits for observation readiness and transfers the lease before publication", async () => {
    const ready = deferred<void>();
    const observed = observation(ready.promise);
    const lease = { id: "lease", path: "/d" };
    loadDirectory.mockResolvedValue({ ok: true, data: { path: "/d", entries: [entry("a")], watch_lease: lease } });
    const listing = createDirectoryListing();
    const pending = listing.load("/d", observed);
    await flush();
    expect(loadDirectory).not.toHaveBeenCalled();
    ready.resolve();
    await expect(pending).resolves.toMatchObject({ ok: true, entries: [entry("a")] });
    expect(observed.accept).toHaveBeenCalledExactlyOnceWith(lease);
    expect(observed.discard).not.toHaveBeenCalled();
    await listing.cleanup();
  });

  it("releases a lease whose observation owner rejects transfer", async () => {
    const observed = observation(Promise.resolve(), false);
    const lease = { id: "stale", path: "/d" };
    loadDirectory.mockResolvedValue({ ok: true, data: { path: "/d", entries: [], watch_lease: lease } });
    const listing = createDirectoryListing();
    await expect(listing.load("/d", observed)).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(observed.discard).toHaveBeenCalledExactlyOnceWith(lease);
    await listing.cleanup();
  });

  it.each(["rejected", "superseded"])("does not read after observation readiness is %s", async (mode) => {
    const ready = deferred<void>();
    let current = true;
    const observed = { ...observation(ready.promise), current: () => current };
    const listing = createDirectoryListing();
    const pending = listing.load("/d", observed);
    await flush();
    if (mode === "rejected") ready.reject(new Error("watch unavailable"));
    else { current = false; ready.resolve(); }
    await expect(pending).resolves.toMatchObject(mode === "rejected"
      ? { ok: false, error: "watch unavailable" }
      : { ok: false, cancelled: true });
    expect(loadDirectory).not.toHaveBeenCalled();
    await listing.cleanup();
  });

  it("drops an in-flight obsolete result and skips superseded queued reads", async () => {
    const first = deferred<ApiResult<ObservedDirectoryListing>>();
    const observed = observation();
    const lease = { id: "old", path: "/old" };
    loadDirectory.mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot([entry("latest")]));
    const listing = createDirectoryListing();
    const a = listing.load("/old", observed);
    await flush();
    const b = listing.load("/skipped");
    const c = listing.load("/latest");
    first.resolve({ ok: true, data: { path: "/old", entries: [entry("stale")], watch_lease: lease } });
    await expect(a).resolves.toMatchObject({ ok: false, cancelled: true });
    await expect(b).resolves.toMatchObject({ ok: false, cancelled: true });
    await expect(c).resolves.toMatchObject({ ok: true, entries: [entry("latest")] });
    expect(loadDirectory.mock.calls.map(([path]) => path)).toEqual(["/old", "/latest"]);
    expect(observed.accept).not.toHaveBeenCalled();
    expect(observed.discard).toHaveBeenCalledExactlyOnceWith(lease);
    await listing.cleanup();
  });

  it("seals cleanup immediately and waits for late lease release", async () => {
    const response = deferred<ApiResult<ObservedDirectoryListing>>();
    loadDirectory.mockReturnValue(response.promise);
    const listing = createDirectoryListing();
    const observed = observation();
    const lease = { id: "late", path: "/d" };
    const pending = listing.load("/d", observed);
    await flush();
    const cleaned = vi.fn();
    const cleanup = listing.cleanup().then(cleaned);
    await flush();
    expect(cleaned).not.toHaveBeenCalled();
    response.resolve({ ok: true, data: { path: "/d", entries: [], watch_lease: lease } });
    await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true });
    await cleanup;
    expect(observed.discard).toHaveBeenCalledExactlyOnceWith(lease);
    expect(observed.accept).not.toHaveBeenCalled();
    await expect(listing.load("/after")).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(loadDirectory).toHaveBeenCalledOnce();
  });

  it("propagates a filesystem failure and permits a later retry", async () => {
    loadDirectory.mockResolvedValueOnce({ ok: false, error: "permission denied" }).mockResolvedValueOnce(snapshot());
    const listing = createDirectoryListing();
    await expect(listing.load("/d")).resolves.toEqual({ ok: false, error: "permission denied" });
    await expect(listing.load("/d")).resolves.toMatchObject({ ok: true });
    await listing.cleanup();
  });
});
