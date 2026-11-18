/** OS recent sources for Date opened (#1526): newest-wins merge and the batched, cached resolver. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newestOpened } from "$lib/domain/open-history";
import { createOsOpenedResolver } from "$lib/state/open-history-combined.svelte";

describe("newestOpened", () => {
  it("prefers the later time from either source", () => {
    expect(newestOpened(100, 200)).toBe(200);
    expect(newestOpened(300, 200)).toBe(300);
    expect(newestOpened(200, 200)).toBe(200);
  });
  it("falls back to whichever source has a value", () => {
    expect(newestOpened(undefined, 5)).toBe(5);
    expect(newestOpened(5, undefined)).toBe(5);
    expect(newestOpened(undefined, undefined)).toBeUndefined();
  });
  it("ignores invalid OS times instead of showing them", () => {
    expect(newestOpened(5, Number.NaN)).toBe(5);
    expect(newestOpened(undefined, -1)).toBeUndefined();
    expect(newestOpened(undefined, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("OS opened resolver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (result: Record<string, number> = {}, enabled = () => true) => {
    const fetch = vi.fn(async (paths: readonly string[]) => Object.fromEntries(paths.filter((p) => p in result).map((p) => [p, result[p]])));
    let clock = 0;
    const resolver = createOsOpenedResolver({ fetch, enabled, now: () => clock, ttlMs: 1000, delayMs: 10 });
    return { fetch, resolver, advance: (ms: number) => { clock += ms; } };
  };

  it("batches every row read in a tick into one request and then serves the values", async () => {
    const { fetch, resolver } = setup({ "/d/a": 111 });
    expect(resolver.get("/d/a")).toBeUndefined();
    resolver.get("/d/b");
    resolver.get("/d/a");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...fetch.mock.calls[0][0]].sort()).toEqual(["/d/a", "/d/b"]);
    expect(resolver.get("/d/a")).toBe(111);
    expect(resolver.get("/d/b")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again once a cached answer is stale", async () => {
    const { fetch, resolver, advance } = setup({ "/d/a": 1 });
    resolver.get("/d/a");
    await vi.advanceTimersByTimeAsync(10);
    advance(2000);
    resolver.get("/d/a");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never calls the backend while disabled", async () => {
    const { fetch, resolver } = setup({ "/d/a": 1 }, () => false);
    expect(resolver.get("/d/a")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps known values and retries on a later read when a fetch fails", async () => {
    let fail = false;
    const fetch = vi.fn(async (paths: readonly string[]) => {
      if (fail) throw new Error("boom");
      return Object.fromEntries(paths.map((p) => [p, 7]));
    });
    let clock = 0;
    const resolver = createOsOpenedResolver({ fetch, enabled: () => true, now: () => clock, ttlMs: 1000, delayMs: 10 });
    resolver.get("/d/a");
    await vi.advanceTimersByTimeAsync(10);
    expect(resolver.get("/d/a")).toBe(7);
    clock += 2000;
    fail = true;
    resolver.get("/d/a");
    await vi.advanceTimersByTimeAsync(10);
    expect(resolver.get("/d/a")).toBe(7); // known value survives the failure
    fail = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3); // the failed read was retried, not blocked for the TTL
    expect(resolver.get("/d/a")).toBe(7);
  });

  it("publishes overlapping flushes without one overwriting the other", async () => {
    const gates: Array<(value: Record<string, number>) => void> = [];
    const fetch = vi.fn(() => new Promise<Record<string, number>>((resolve) => gates.push(resolve)));
    const resolver = createOsOpenedResolver({ fetch, enabled: () => true, delayMs: 10 });
    resolver.get("/d/a");
    await vi.advanceTimersByTimeAsync(10);
    resolver.get("/d/b");
    await vi.advanceTimersByTimeAsync(10);
    expect(gates).toHaveLength(2);
    gates[1]({ "/d/b": 2 }); // the later request settles first
    await vi.advanceTimersByTimeAsync(0);
    gates[0]({ "/d/a": 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect([resolver.get("/d/a"), resolver.get("/d/b")]).toEqual([1, 2]);
  });
});
