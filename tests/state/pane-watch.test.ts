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
    watchDirectory.mockClear();
    unwatchDirectory.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("watches a new path and releases the previous one", () => {
    const watch = createPaneWatch();

    watch.update("/a");
    expect(watchDirectory).toHaveBeenCalledWith("/a");
    expect(unwatchDirectory).not.toHaveBeenCalled();

    watch.update("/b");
    expect(unwatchDirectory).toHaveBeenCalledWith("/a");
    expect(watchDirectory).toHaveBeenCalledWith("/b");
  });

  it("does not re-watch when the path is unchanged", () => {
    const watch = createPaneWatch();
    watch.update("/a");
    watch.update("/a");
    expect(watchDirectory).toHaveBeenCalledTimes(1);
    expect(unwatchDirectory).not.toHaveBeenCalled();
  });

  it("destroy releases the active watch exactly once", () => {
    const watch = createPaneWatch();
    watch.update("/a");
    watch.destroy();
    watch.destroy();
    expect(unwatchDirectory).toHaveBeenCalledTimes(1);
    expect(unwatchDirectory).toHaveBeenCalledWith("/a");
  });

  it("destroy without a watch is a no-op", () => {
    const watch = createPaneWatch();
    watch.destroy();
    expect(unwatchDirectory).not.toHaveBeenCalled();
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
