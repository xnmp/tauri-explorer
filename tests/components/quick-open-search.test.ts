import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuickOpenSearchController } from "$lib/domain/quick-open-search";

describe("Quick Open recursive-search scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts one recursive search for the completed rapid query", () => {
    const startSearch = vi.fn();
    const immediateMatches = vi.fn((query: string) => [{ name: `${query}-in-pane` }]);
    const cancelActiveSearch = vi.fn();
    const controller = createQuickOpenSearchController({
      startSearch,
      immediateMatches,
      cancelActiveSearch,
    });

    expect(controller.handleInput("c")).toEqual([{ name: "c-in-pane" }]);
    vi.advanceTimersByTime(40);
    expect(controller.handleInput("ca")).toEqual([{ name: "ca-in-pane" }]);
    vi.advanceTimersByTime(40);
    // The completed query's active-pane match is visible before its recursive
    // backend request is allowed to begin.
    expect(controller.handleInput("capture")).toEqual([{ name: "capture-in-pane" }]);

    // Matching the active pane remains synchronous; the costly recursive
    // search waits until typing has paused.
    expect(startSearch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(startSearch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(startSearch).toHaveBeenCalledTimes(1);
    expect(startSearch).toHaveBeenCalledWith("capture");
    expect(immediateMatches).toHaveBeenCalledTimes(3);
    expect(cancelActiveSearch).toHaveBeenCalledTimes(3);
  });
});
