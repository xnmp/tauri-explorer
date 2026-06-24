/**
 * Pointer-intent deadzone: hover-selection in keyboard-driven pickers must
 * ignore mouse drift (corded mouse on a low-friction pad) and only react to a
 * deliberate move past a small threshold, re-anchoring on keyboard nav.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { usePointerIntent } from "$lib/composables/use-pointer-intent.svelte";

describe("usePointerIntent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ignores movement during the grace period", () => {
    const p = usePointerIntent(6);
    p.arm(150);
    p.track(100, 100);
    p.track(200, 200); // big move, but tracking not ready yet
    expect(p.moved).toBe(false);
  });

  it("ignores drift within the deadzone once ready", () => {
    const p = usePointerIntent(6);
    p.arm(150);
    vi.advanceTimersByTime(150);
    p.track(100, 100); // anchors here
    p.track(103, 101); // ~3px → drift
    p.track(98, 102); // jitter back
    expect(p.moved).toBe(false);
  });

  it("flips on a deliberate move past the threshold", () => {
    const p = usePointerIntent(6);
    p.arm(150);
    vi.advanceTimersByTime(150);
    p.track(100, 100); // anchor
    p.track(110, 100); // 10px > 6
    expect(p.moved).toBe(true);
  });

  it("re-anchors on reset so drift after keyboard nav is ignored", () => {
    const p = usePointerIntent(6);
    p.arm(150);
    vi.advanceTimersByTime(150);
    p.track(100, 100);
    p.track(120, 100); // deliberate
    expect(p.moved).toBe(true);

    p.reset(); // e.g. user pressed an arrow key — re-anchor at (120,100)
    expect(p.moved).toBe(false);
    p.track(122, 100); // 2px drift from new anchor
    expect(p.moved).toBe(false);
    p.track(132, 100); // 12px → deliberate again
    expect(p.moved).toBe(true);
  });
});
