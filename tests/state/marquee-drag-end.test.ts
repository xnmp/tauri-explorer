/**
 * A marquee that never dragged has not "just ended" a drag (#1387): the first
 * clicks within DRAG_END_GRACE_MS of page load are plain clicks, so caret-less
 * Folder Peek toggles on them instead of treating them as a drag's release.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMarqueeSelection } from "$lib/composables/use-marquee-selection.svelte";

describe("marquee drag-end window", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports no drag end before any drag, even right after page load", () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const marquee = useMarqueeSelection();
    expect(marquee.dragJustEnded).toBe(false);
    expect(marquee.consumeDragEndClick()).toBe(false);
  });
});
