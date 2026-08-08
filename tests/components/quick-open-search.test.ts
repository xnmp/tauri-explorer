import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQuickOpenSearchController,
  createQuickOpenStreamResources,
} from "$lib/domain/quick-open-search";

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

  it("keeps the replacement stream listener when earlier cancellation resolves late", async () => {
    let releaseCancellation = () => {};
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancelSearch = vi.fn(async () => cancellationGate);
    const resources = createQuickOpenStreamResources(cancelSearch);
    const delivered: string[] = [];
    const listeners = new Map<number, (searchId: number, result: string) => void>();
    let nextListenerId = 0;

    const installListener = () => {
      const listenerId = ++nextListenerId;
      listeners.set(listenerId, (searchId, result) => {
        if (resources.matchesOrAdopts(searchId)) delivered.push(result);
      });
      resources.replaceListener(() => {
        listeners.delete(listenerId);
      });
      return listenerId;
    };

    resources.setSearchId(1);
    installListener();
    const cancellingFirstSearch = resources.cancel();
    expect(cancelSearch).toHaveBeenCalledWith(1);

    resources.setSearchId(2);
    const replacementListenerId = installListener();
    expect(listeners.has(replacementListenerId)).toBe(true);
    releaseCancellation();
    await cancellingFirstSearch;

    listeners.get(replacementListenerId)?.(2, "final recursive result");
    expect(resources.searchId).toBe(2);
    expect(delivered).toEqual(["final recursive result"]);
  });
});
