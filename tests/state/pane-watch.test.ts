/**
 * Pane filesystem-watch lifecycle and local-mutation cooldown
 * (src/lib/state/pane-watch.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const watchDirectory = vi.fn();
const unwatchDirectory = vi.fn();

vi.mock("$lib/api/files", () => ({
  watchDirectory: (...args: unknown[]) => watchDirectory(...args),
  unwatchDirectory: (...args: unknown[]) => unwatchDirectory(...args),
}));

import { createPaneWatch, MUTATION_COOLDOWN_MS } from "../../src/lib/state/pane-watch";

describe("createPaneWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watchDirectory.mockReset().mockResolvedValue(undefined);
    unwatchDirectory.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("watches a new path and releases the previous one", async () => {
    const watch = createPaneWatch();

    await watch.update("/a");
    expect(watchDirectory).toHaveBeenCalledWith("/a");
    expect(unwatchDirectory).not.toHaveBeenCalled();

    await watch.update("/b");
    expect(unwatchDirectory).toHaveBeenCalledWith("/a");
    expect(watchDirectory).toHaveBeenCalledWith("/b");
  });

  it("does not re-watch when the path is unchanged", async () => {
    const watch = createPaneWatch();
    await watch.update("/a");
    await watch.update("/a");
    expect(watchDirectory).toHaveBeenCalledTimes(1);
    expect(unwatchDirectory).not.toHaveBeenCalled();
  });

  it("destroy releases the active watch exactly once", async () => {
    const watch = createPaneWatch();
    await watch.update("/a");
    await watch.destroy();
    await watch.destroy();
    expect(unwatchDirectory).toHaveBeenCalledTimes(1);
    expect(unwatchDirectory).toHaveBeenCalledWith("/a");
  });

  it("destroy without a watch is a no-op", () => {
    const watch = createPaneWatch();
    watch.destroy();
    expect(unwatchDirectory).not.toHaveBeenCalled();
  });

  it("waits for an acquired watch before releasing it during destruction", async () => {
    let acquire!: () => void;
    let held = 0;
    watchDirectory.mockImplementation(() => new Promise<void>((resolve) => {
      acquire = () => { held++; resolve(); };
    }));
    unwatchDirectory.mockImplementation(async () => { held = Math.max(0, held - 1); });
    const watch = createPaneWatch();
    const updated = watch.update("/a");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const disposed = Promise.resolve(watch.destroy());
    acquire();
    await Promise.all([updated, disposed]);
    expect(held).toBe(0);
    expect(unwatchDirectory).toHaveBeenCalledOnce();
  });

  it("ignores obsolete queued paths and cannot reacquire after destruction", async () => {
    const watch = createPaneWatch();
    watch.update("/a");
    watch.update("/b");
    await watch.update("/c");
    await watch.destroy();
    await watch.update("/late");
    expect(watchDirectory).toHaveBeenCalledTimes(1);
    expect(watchDirectory).toHaveBeenCalledWith("/c");
    expect(unwatchDirectory).toHaveBeenCalledWith("/c");
  });

  it("cooldown is active right after a mutation and expires after the window", () => {
    const watch = createPaneWatch();
    expect(watch.inMutationCooldown()).toBe(false);

    watch.markLocalMutation();
    expect(watch.inMutationCooldown()).toBe(true);

    vi.advanceTimersByTime(MUTATION_COOLDOWN_MS - 1);
    expect(watch.inMutationCooldown()).toBe(true);

    vi.advanceTimersByTime(2);
    expect(watch.inMutationCooldown()).toBe(false);
  });
});
