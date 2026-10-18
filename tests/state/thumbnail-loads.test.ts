/**
 * Shared thumbnail loads (#1241 review): a tile that unmounts mid-request does
 * not lose the response, a remount joins the load in flight instead of asking
 * again, every blob URL ends in the cache, and queued work still starts only
 * for a tile on screen (#136).
 */
import { describe, expect, it } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { CachedThumbnail } from "$lib/state/thumbnail-cache";
import { createPool, createThumbnailLoads, type ThumbnailState } from "$lib/state/thumbnail-loads";

/** A request the test settles by hand, counting how often it was asked. */
function deferredRequests(key: string) {
  const asked = { micro: 0, full: 0 };
  const waiting: Record<"micro" | "full", ((result: ApiResult<string>) => void)[]> = { micro: [], full: [] };
  const request = (stage: "micro" | "full") => () => {
    asked[stage]++;
    return new Promise<ApiResult<string>>(resolve => waiting[stage].push(resolve));
  };
  return {
    asked,
    requests: { micro: request("micro"), full: request("full") },
    video: { full: request("full") },
    answer(stage: "micro" | "full", ok = true) {
      const resolve = waiting[stage].shift();
      if (!resolve) throw new Error(`no ${stage} request waiting for ${key}`);
      resolve(ok ? { ok: true, data: `blob:${stage}-${key}` } : { ok: false, error: `${stage} failed` });
    },
  };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(pools = { micro: createPool(8), full: createPool(4) }) {
  const cache = new Map<string, CachedThumbnail>();
  const loads = createThumbnailLoads({ pools, cache: { get: key => cache.get(key), set: (key, value) => { cache.set(key, value); } } });
  const tile = (visible = true) => {
    const seen: ThumbnailState[] = [];
    let onScreen = visible;
    return {
      seen, last: () => seen.at(-1)!,
      watcher: { visible: () => onScreen, update: (state: ThumbnailState) => { seen.push(state); } },
      setVisible(next: boolean) { onScreen = next; },
    };
  };
  return { cache, loads, tile };
}

describe("shared thumbnail loads", () => {
  it("shows the micro then the full thumbnail, publishing the result to the cache", async () => {
    const { cache, loads, tile } = setup();
    const req = deferredRequests("a");
    const a = tile();
    loads.watch("a", req.requests, a.watcher);
    expect(a.last()).toMatchObject({ micro: null, full: null, settled: false });
    await flush(); req.answer("micro"); await flush();
    expect(a.last()).toMatchObject({ micro: "blob:micro-a", full: null, settled: false });
    req.answer("full"); await flush();
    expect(a.last()).toEqual({ micro: "blob:micro-a", full: "blob:full-a", error: null, settled: true, cached: false });
    expect(cache.get("a")).toEqual({ micro: "blob:micro-a", full: "blob:full-a" });
    expect(loads.inFlight).toBe(0);
  });

  it("keeps a response that arrives after its tile unmounted, so the remount asks nothing", async () => {
    const { cache, loads, tile } = setup();
    const req = deferredRequests("a");
    const first = tile();
    const stop = loads.watch("a", req.requests, first.watcher);
    await flush();
    stop(); // unmounted while the micro request is in flight
    const updates = first.seen.length;
    req.answer("micro"); await flush();
    // The micro arrived: its full is fetched with no watcher left.
    expect(req.asked).toEqual({ micro: 1, full: 1 });
    req.answer("full"); await flush();
    expect(first.seen).toHaveLength(updates);
    expect(cache.get("a")).toEqual({ micro: "blob:micro-a", full: "blob:full-a" });
    const again = tile();
    loads.watch("a", req.requests, again.watcher);
    expect(again.seen).toEqual([{ micro: "blob:micro-a", full: "blob:full-a", error: null, settled: true, cached: true }]);
    expect(req.asked).toEqual({ micro: 1, full: 1 });
  });

  it("lets a remount join the load still in flight instead of requesting again", async () => {
    const { loads, tile } = setup();
    const req = deferredRequests("a");
    const stop = loads.watch("a", req.requests, tile().watcher);
    await flush(); stop(); // unmounted mid-request
    req.answer("micro"); await flush();
    const remount = tile();
    loads.watch("a", req.requests, remount.watcher);
    // The remount paints the micro thumbnail that already arrived.
    expect(remount.last()).toMatchObject({ micro: "blob:micro-a", settled: false });
    req.answer("full"); await flush();
    expect(remount.last()).toMatchObject({ full: "blob:full-a", settled: true, cached: false });
    expect(req.asked).toEqual({ micro: 1, full: 1 });
  });

  it("never starts queued work for a key with no watcher on screen", async () => {
    const { loads, tile } = setup({ micro: createPool(1), full: createPool(1) });
    const busy = deferredRequests("busy"), queued = deferredRequests("queued"), hidden = deferredRequests("hidden");
    loads.watch("busy", busy.requests, tile().watcher);
    const stopQueued = loads.watch("queued", queued.requests, tile().watcher);
    const offScreen = tile();
    loads.watch("hidden", hidden.requests, offScreen.watcher);
    offScreen.setVisible(false);
    stopQueued(); // scrolled past before its slot came
    await flush(); busy.answer("micro"); await flush();
    busy.answer("full"); await flush();
    expect(queued.asked).toEqual({ micro: 0, full: 0 });
    expect(hidden.asked).toEqual({ micro: 0, full: 0 });
    expect(loads.inFlight).toBe(0);
    // A tile that comes back starts a fresh load.
    const back = tile();
    loads.watch("queued", queued.requests, back.watcher);
    await flush();
    expect(queued.asked.micro).toBe(1);
  });

  it("caches the micro alone when the full fails, and reports an error only when both fail", async () => {
    const { cache, loads, tile } = setup();
    const partial = deferredRequests("p"), broken = deferredRequests("b");
    const p = tile(), b = tile();
    loads.watch("p", partial.requests, p.watcher);
    loads.watch("b", broken.requests, b.watcher);
    await flush(); partial.answer("micro"); broken.answer("micro", false); await flush();
    partial.answer("full", false); broken.answer("full", false); await flush();
    expect(p.last()).toEqual({ micro: "blob:micro-p", full: null, error: null, settled: true, cached: false });
    expect(cache.get("p")).toEqual({ micro: "blob:micro-p", full: null });
    expect(b.last()).toMatchObject({ micro: null, full: null, error: "full failed", settled: true });
    expect(cache.has("b")).toBe(false);
  });

  it("loads a video frame in one request, and treats a rejected request as a failure", async () => {
    const { cache, loads, tile } = setup();
    const req = deferredRequests("v");
    const v = tile();
    loads.watch("v", req.video, v.watcher);
    await flush(); req.answer("full"); await flush();
    expect(v.last()).toMatchObject({ micro: null, full: "blob:full-v", settled: true });
    expect(cache.get("v")).toEqual({ micro: null, full: "blob:full-v" });
    const thrown = tile();
    loads.watch("x", { full: () => Promise.reject(new Error("ipc closed")) }, thrown.watcher);
    await flush();
    expect(thrown.last()).toMatchObject({ settled: true, error: "Error: ipc closed" });
    expect(loads.inFlight).toBe(0);
  });
});
