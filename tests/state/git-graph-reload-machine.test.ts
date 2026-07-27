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
