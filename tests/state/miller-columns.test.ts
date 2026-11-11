import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import type { DirectoryChange } from "$lib/state/directory-events";
import { createMillerColumns } from "$lib/state/miller-columns.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const dir = (path: string): FileEntry => ({
  name: path.split("/").pop()!, path, kind: "directory", size: null, modified: null,
} as unknown as FileEntry);
const listing = (path: string, children: string[]): ApiResult<DirectoryListing> =>
  ({ ok: true, data: { path, entries: children.map((name) => dir(`${path}/${name}`)) } });

type Scheduled = { run: () => unknown; path: string; observedAt?: number; origin?: string };

function fixture(options: { hideEmpty?: boolean; holdWatch?: boolean; holdListener?: boolean } = {}) {
  const watchReady = deferred<void>();
  const listenerReady = deferred<void>();
  const lists = new Map<string, ReturnType<typeof deferred<ApiResult<DirectoryListing>>>[]>();
  const empties: { path: string; includeHidden: boolean; d: ReturnType<typeof deferred<boolean>> }[] = [];
  const watches: { path: string | null; destroyed: boolean }[] = [];
  let onChange: ((change: DirectoryChange) => void) | undefined;
  let onLocal: ((dirs: string[]) => void) | undefined;
  const scheduled: Scheduled[] = [];
  const cancelled: string[] = [];
  const settings = { hideEmpty: options.hideEmpty ?? false, includeHidden: false };
  const stopped = { events: false, local: false };
  const columns = createMillerColumns({
    list: vi.fn((path: string) => {
      const d = deferred<ApiResult<DirectoryListing>>();
      lists.set(path, [...(lists.get(path) ?? []), d]);
      return d.promise;
    }),
    isEmpty: vi.fn((path: string, includeHidden: boolean) => {
      const d = deferred<boolean>();
      empties.push({ path, includeHidden, d });
      return d.promise;
    }),
    createWatch: () => {
      const watch = { path: null as string | null, destroyed: false };
      watches.push(watch);
      return {
        update: async (path: string) => { watch.path = path; if (options.holdWatch) await watchReady.promise; },
        destroy: async () => { watch.destroyed = true; },
      };
    },
    subscribe: (callback) => {
      onChange = callback;
      return { ready: async () => { if (options.holdListener) await listenerReady.promise; }, stop: () => { stopped.events = true; } };
    },
    subscribeLocal: (callback) => {
      onLocal = callback;
      return () => { stopped.local = true; };
    },
    schedule: (run, path, _silent, _key, observedAt, origin) => {
      scheduled.push({ run: () => run({ silent: true }), path, observedAt, origin });
    },
    cancelScheduled: (path) => { cancelled.push(path); },
    hideEmpty: () => settings.hideEmpty,
    includeHidden: () => settings.includeHidden,
  });
  const calls = (path: string) => lists.get(path) ?? [];
  const names = (path: string) => columns.entries(path)?.map((entry) => entry.name);
  return {
    columns, calls, names, watches, scheduled, cancelled, settings, empties, stopped,
    admitWatch: () => watchReady.resolve(undefined),
    failWatch: () => watchReady.reject(new Error("watch unavailable")),
    admitListener: () => listenerReady.resolve(undefined),
    watcher: (change: DirectoryChange) => onChange!(change),
    local: (dirs: string[]) => onLocal!(dirs),
  };
}

describe("Miller ancestor listings", () => {
  it.each(["watch", "listener"] as const)("waits for both admissions when %s becomes ready first", async (first) => {
    const f = fixture({ holdWatch: true, holdListener: true });
    f.columns.show(["/a"]);
    await settle();
    expect(f.calls("/a")).toHaveLength(0);
    const admit = { watch: f.admitWatch, listener: f.admitListener };
    admit[first]();
    await settle();
    expect(f.calls("/a")).toHaveLength(0);
    admit[first === "watch" ? "listener" : "watch"]();
    await settle();
    expect(f.calls("/a")).toHaveLength(1);
    f.calls("/a")[0].resolve(listing("/a", ["written-during-admission"]));
    await settle();
    expect(f.names("/a")).toEqual(["written-during-admission"]);
  });

  it.each(["hide", "dispose"] as const)("does not scan after pending admission when the column is retired by %s", async (retire) => {
    const f = fixture({ holdWatch: true });
    f.columns.show(["/a"]);
    if (retire === "hide") f.columns.show([]);
    else f.columns.dispose();
    f.admitWatch();
    await settle();
    expect(f.calls("/a")).toHaveLength(0);
  });

  it("only the replacement owner scans when a column returns before old admission settles", async () => {
    const f = fixture({ holdWatch: true });
    f.columns.show(["/a"]);
    f.columns.show([]);
    f.columns.show(["/a"]);
    f.admitWatch();
    await settle();
    expect(f.calls("/a")).toHaveLength(1);
    f.calls("/a")[0].resolve(listing("/a", ["current-owner"]));
    await settle();
    expect(f.names("/a")).toEqual(["current-owner"]);
  });

  it("still permits an explicit fresh listing when watch admission fails", async () => {
    const f = fixture({ holdWatch: true });
    f.columns.show(["/a"]);
    f.failWatch();
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["available"]));
    await settle();
    expect(f.names("/a")).toEqual(["available"]);
  });

  it("a slow listing cannot overwrite the newer listing that superseded it", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.local(["/a"]); // a local mutation re-reads the column while the first read is slow
    await settle();
    expect(f.calls("/a")).toHaveLength(2);
    f.calls("/a")[1].resolve(listing("/a", ["fresh"]));
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["stale"]));
    await settle();
    expect(f.names("/a")).toEqual(["fresh"]);
  });

  it("a column has no listing until its first read, then shows it sorted by name", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    expect(f.columns.entries("/a")).toBeUndefined();
    f.calls("/a")[0].resolve(listing("/a", ["b", "C", "a"]));
    await settle();
    expect(f.names("/a")).toEqual(["a", "b", "C"]);
  });

  it("an initial listing failure leaves the column without a listing and is retried when the columns are shown again", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.calls("/a")[0].resolve({ ok: false, error: "denied" });
    await settle();
    expect(f.columns.entries("/a")).toBeUndefined();
    f.columns.show(["/a"]);
    await settle();
    expect(f.calls("/a")).toHaveLength(2);
    f.calls("/a")[1].resolve(listing("/a", ["x"]));
    await settle();
    expect(f.names("/a")).toEqual(["x"]);
  });

  it("a thrown listing is a failure, not an unhandled rejection", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.calls("/a")[0].reject(new Error("ipc gone"));
    await settle();
    expect(f.columns.entries("/a")).toBeUndefined();
  });

  it("a failed re-read keeps the entries already shown", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["kept"]));
    await settle();
    f.local(["/a"]);
    await settle();
    f.calls("/a")[1].resolve({ ok: false, error: "gone" });
    await settle();
        expect(f.names("/a")).toEqual(["kept"]);
  });

  it("a local mutation re-reads a visible column immediately (#598)", async () => {
    const f = fixture();
    f.columns.show(["/a", "/a/b"]);
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["b", "moved"]));
    f.calls("/a/b")[0].resolve(listing("/a/b", []));
    await settle();
    f.local(["/a"]);
    await settle();
    expect(f.calls("/a")).toHaveLength(2);
    expect(f.scheduled).toHaveLength(0);
    f.calls("/a")[1].resolve(listing("/a", ["b"]));
    await settle();
    expect(f.names("/a")).toEqual(["b"]);
    expect(f.calls("/a/b")).toHaveLength(1);
  });

  it("schedules a watcher change through the refresh manager and reads only when it runs", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["old"]));
    await settle();
    f.watcher({ path: "/a", observedAt: 42, origin: "watcher" });
    expect(f.calls("/a")).toHaveLength(1);
    expect(f.scheduled).toMatchObject([{ path: "/a", observedAt: 42, origin: "watcher" }]);
    const run = f.scheduled[0].run();
    await settle();
    expect(run).toBeInstanceOf(Promise); // the manager measures the read it started
    f.calls("/a")[1].resolve(listing("/a", ["new"]));
    await run;
    expect(f.names("/a")).toEqual(["new"]);
  });

  it("a watcher change during a slow first listing replaces it", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.watcher({ path: "/a" });
    void f.scheduled[0].run();
    await settle();
    f.calls("/a")[1].resolve(listing("/a", ["after-change"]));
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["before-change"]));
    await settle();
    expect(f.names("/a")).toEqual(["after-change"]);
  });

  it("declines a scheduled read for a column that is no longer shown", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["x"]));
    await settle();
    f.watcher({ path: "/a" });
    f.columns.show([]);
    await settle();
    expect(f.cancelled).toContain("/a");
    expect(f.scheduled[0].run()).toBe(false);
    expect(f.calls("/a")).toHaveLength(1);
  });

  it("re-reads a column hidden with a change still pending when it is shown again", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["old"]));
    await settle();
    f.watcher({ path: "/a" });
    f.columns.show([]);
    await settle();
    f.columns.show(["/a"]);
    await settle();
    expect(f.columns.entries("/a")).toBeUndefined();
    expect(f.calls("/a")).toHaveLength(2);
  });

  it("shows a cached column immediately and revalidates after its unwatched gap", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["x"]));
    await settle();
    f.columns.show(["/b"]);
    await settle();
    f.columns.show(["/a"]);
    await settle();
    expect(f.calls("/a")).toHaveLength(2);
    expect(f.names("/a")).toEqual(["x"]);
    f.calls("/a")[1].resolve(listing("/a", ["changed-while-hidden"]));
    await settle();
    expect(f.names("/a")).toEqual(["changed-while-hidden"]);
  });

  it("drops a hidden cached listing that changed, by watcher or local mutation", async () => {
    const f = fixture();
    f.columns.show(["/a", "/b"]);
    await settle();
    f.calls("/a")[0].resolve(listing("/a", ["x"]));
    f.calls("/b")[0].resolve(listing("/b", ["y"]));
    await settle();
    f.columns.show(["/c"]);
    await settle();
    f.watcher({ path: "/a" });
    f.local(["/b"]);
    await settle();
    expect(f.scheduled).toHaveLength(0);
    f.columns.show(["/a", "/b"]);
    await settle();
    expect(f.calls("/a")).toHaveLength(2);
    expect(f.calls("/b")).toHaveLength(2);
    expect([f.columns.entries("/a"), f.columns.entries("/b")]).toEqual([undefined, undefined]);
  });

  it("bounds hidden listings at 50 while never evicting a shown column", async () => {
    const f = fixture();
    f.columns.show(["/keep"]);
    await settle();
    f.calls("/keep")[0].resolve(listing("/keep", ["k"]));
    await settle();
    for (let i = 0; i < 60; i++) {
      const path = `/d${i}`;
      f.columns.show(["/keep", path]);
      await settle();
      f.calls(path)[0].resolve(listing(path, ["e"]));
      await settle();
    }
    f.columns.show(["/keep", "/d0", "/d59"]);
    await settle();
    expect(f.calls("/keep")).toHaveLength(1);
    expect(f.names("/d59")).toEqual(["e"]);
    expect(f.calls("/d59")).toHaveLength(1);
    expect(f.names("/d0")).toBeUndefined();
    expect(f.calls("/d0")).toHaveLength(2);
  });

  it("owns one directory watch per shown column", async () => {
    const f = fixture();
    f.columns.show(["/a", "/b"]);
    await settle();
    await settle();
    expect(f.watches.map((watch) => watch.path)).toEqual(["/a", "/b"]);
    f.columns.show(["/b", "/c"]);
    await settle();
    await settle();
    expect(f.watches.map((watch) => [watch.path, watch.destroyed])).toEqual([
      ["/a", true], ["/b", false], ["/c", false],
    ]);
  });

  it("disposal releases watches and subscriptions and ignores late listings", async () => {
    const f = fixture();
    f.columns.show(["/a"]);
    await settle();
    f.columns.dispose();
    expect(f.watches.every((watch) => watch.destroyed)).toBe(true);
    expect(f.stopped).toEqual({ events: true, local: true });
    expect(f.cancelled).toContain("/a");
    f.calls("/a")[0].resolve(listing("/a", ["late"]));
    await settle();
    f.columns.show(["/a"]);
    await settle();
    expect(f.calls("/a")).toHaveLength(1);
  });

  describe("empty-folder flags", () => {
    it("does not restore obsolete empty answers after a local mutation", async () => {
      const f = fixture({ hideEmpty: true });
      f.columns.show(["/a"]);
      await settle();
      f.calls("/a")[0].resolve(listing("/a", ["x"]));
      await settle();
      f.local(["/a/x", "/a"]);
      await settle();
      f.calls("/a")[1].resolve(listing("/a", ["x"]));
      await settle();
      f.empties[1].d.resolve(false);
      await settle();
      expect(f.columns.isEmpty("/a/x")).toBe(false);
      f.empties[0].d.resolve(true);
      await settle();
      expect(f.columns.isEmpty("/a/x")).toBe(false);
    });

    it("a mutation invalidates an in-flight probe before its replacement finishes", async () => {
      const f = fixture({ hideEmpty: true });
      f.columns.show(["/a"]);
      await settle();
      f.calls("/a")[0].resolve(listing("/a", ["x"]));
      await settle();
      f.local(["/a/x", "/a"]);
      await settle();
      f.empties[0].d.resolve(true);
      await settle();
      expect(f.columns.isEmpty("/a/x")).toBeUndefined();
    });

    it("probes loaded directories only while hiding empty folders", async () => {
      const f = fixture({ hideEmpty: true });
      f.columns.show(["/a"]);
      await settle();
      f.calls("/a")[0].resolve(listing("/a", ["empty", "full"]));
      await settle();
      expect(f.empties.map(({ path }) => path)).toEqual(["/a/empty", "/a/full"]);
      f.empties[0].d.resolve(true);
      f.empties[1].d.resolve(false);
      await settle();
      expect(f.columns.isEmpty("/a/empty")).toBe(true);
      expect(f.columns.isEmpty("/a/full")).toBe(false);

      const g = fixture();
      g.columns.show(["/a"]);
      await settle();
      g.calls("/a")[0].resolve(listing("/a", ["x"]));
      await settle();
      expect(g.empties).toHaveLength(0);
      g.settings.hideEmpty = true;
      g.columns.probeEmptyFlags();
      expect(g.empties.map(({ path }) => path)).toEqual(["/a/x"]);
    });

    it("forgets flags when hidden-file visibility changes, and ignores probes for the old setting", async () => {
      const f = fixture({ hideEmpty: true });
      f.columns.show(["/a"]);
      await settle();
      f.calls("/a")[0].resolve(listing("/a", ["x"]));
      await settle();
      f.settings.includeHidden = true;
      expect(f.columns.isEmpty("/a/x")).toBeUndefined();
      f.empties[0].d.resolve(true); // probed with hidden files excluded
      await settle();
      expect(f.columns.isEmpty("/a/x")).toBeUndefined();
      f.columns.probeEmptyFlags();
      expect(f.empties[1]).toMatchObject({ path: "/a/x", includeHidden: true });
      f.empties[1].d.resolve(false);
      await settle();
      expect(f.columns.isEmpty("/a/x")).toBe(false);
    });

    it("a change forgets the flags of the directory and its parent", async () => {
      const f = fixture({ hideEmpty: true });
      f.columns.show(["/a", "/a/b"]);
      await settle();
      f.calls("/a")[0].resolve(listing("/a", ["b"]));
      f.calls("/a/b")[0].resolve(listing("/a/b", ["c"]));
      await settle();
      for (const probe of f.empties) probe.d.resolve(true);
      await settle();
      expect(f.columns.isEmpty("/a/b")).toBe(true);
      expect(f.columns.isEmpty("/a/b/c")).toBe(true);
      f.watcher({ path: "/a/b/c" });
      expect(f.columns.isEmpty("/a/b/c")).toBeUndefined();
      expect(f.columns.isEmpty("/a/b")).toBeUndefined();
    });
  });
});
