import { describe, expect, it } from "vitest";
import {
  countGraphWalkCommits,
  createReloader,
  shouldReloadGraphForChange,
} from "$lib/state/git-graph-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createReloader", () => {
  it("runs one follow-up fetch when refreshed while the current fetch is in flight", async () => {
    const fetches: Array<ReturnType<typeof deferred<string>>> = [];
    let displayed = "";
    const reloader = createReloader(async ({ isCurrent }) => {
      const fetch = deferred<string>();
      fetches.push(fetch);
      const snapshot = await fetch.promise;
      if (isCurrent()) displayed = snapshot;
    });

    void reloader.reload();
    void reloader.reload();
    expect(fetches).toHaveLength(1);

    fetches[0].resolve("STALE");
    await settle();
    expect(fetches).toHaveLength(2);

    fetches[1].resolve("FRESH");
    await settle();
    expect(displayed).toBe("FRESH");
  });

  it("marks a completed fetch generation stale once its queued refresh begins", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let firstIsCurrent: (() => boolean) | undefined;
    let calls = 0;
    const reloader = createReloader(async ({ isCurrent }) => {
      calls += 1;
      if (calls === 1) {
        firstIsCurrent = isCurrent;
        await first.promise;
      } else {
        await second.promise;
      }
    });

    void reloader.reload();
    void reloader.reload();
    first.resolve();
    await settle();

    expect(firstIsCurrent?.()).toBe(false);
    second.resolve();
    await settle();
  });
});

describe("git graph refresh helpers", () => {
  it("filters an action's local change echo but accepts watcher changes", () => {
    expect(shouldReloadGraphForChange({ source: "local" })).toBe(false);
    expect(shouldReloadGraphForChange({ source: "watcher" })).toBe(true);
  });

  it("counts only real commits when calculating a filtered graph page offset", () => {
    expect(
      countGraphWalkCommits([
        { oid: "stash-1", stash: true },
        { oid: "commit-1", stash: false },
        { oid: "stash-2", stash: true },
        { oid: "commit-2" },
      ]),
    ).toBe(2);
  });
});

it("invalidates active publication as soon as a newer reload is requested", async () => {
  const first = deferred<void>();
  let calls = 0;
  const published: string[] = [];
  const reloader = createReloader(async ({ isCurrent }) => {
    const current = ++calls;
    if (current === 1) await first.promise;
    if (isCurrent()) published.push(current === 1 ? "stale" : "fresh");
  });
  const initial = reloader.reload();
  const following = reloader.reload();
  first.resolve();
  await Promise.all([initial, following]);
  await settle();
  expect(published).toEqual(["fresh"]);
});

it("disposing a graph rejects late publication and discards queued reloads", async () => {
  const result = deferred<void>();
  let calls = 0; let published = false;
  const reloader = createReloader(async ({ isCurrent }) => {
    calls++;
    await result.promise;
    if (isCurrent()) published = true;
  });
  const pending = reloader.reload();
  void reloader.reload();
  reloader.dispose();
  result.resolve();
  await pending;
  await reloader.reload();
  expect(published).toBe(false);
  expect(calls).toBe(1);
});

it("a queued reload survives an obsolete failed request and is awaited", async () => {
  const first = deferred<void>(); const next = deferred<void>();
  let calls = 0; let done = false;
  const reloader = createReloader(async () => {
    if (++calls === 1) { await first.promise; throw new Error("obsolete"); }
    await next.promise;
  });
  const pending = reloader.reload();
  const queued = reloader.reload().then(() => { done = true; });
  first.resolve();
  await settle();
  expect(calls).toBe(2);
  expect(done).toBe(false);
  next.resolve();
  await Promise.all([pending, queued]);
  expect(done).toBe(true);
});
