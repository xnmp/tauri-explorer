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

  it("treats a failing backend as no OS data", async () => {
    const fetch = vi.fn(async () => { throw new Error("boom"); });
    const resolver = createOsOpenedResolver({ fetch, enabled: () => true, delayMs: 10 });
    resolver.get("/d/a");
    await vi.advanceTimersByTimeAsync(10);
    expect(resolver.get("/d/a")).toBeUndefined();
  });
});
