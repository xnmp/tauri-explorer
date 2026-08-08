import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuickOpenSearchScheduler } from "$lib/domain/quick-open-search";

describe("Quick Open recursive-search scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts one recursive search for the completed rapid query", () => {
    const startSearch = vi.fn();
    const scheduler = createQuickOpenSearchScheduler(startSearch);

    scheduler.schedule("c");
    vi.advanceTimersByTime(40);
    scheduler.schedule("ca");
    vi.advanceTimersByTime(40);
    scheduler.schedule("capture");

    // Matching the active pane remains synchronous; the costly recursive
    // search waits until typing has paused.
    expect(startSearch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(startSearch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(startSearch).toHaveBeenCalledTimes(1);
    expect(startSearch).toHaveBeenCalledWith("capture");
  });
});
