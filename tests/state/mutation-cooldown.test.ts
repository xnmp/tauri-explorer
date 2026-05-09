/**
 * Mutation cooldown: verify the concept that watcher-triggered refreshes
 * are suppressed during a cooldown window after local mutations.
 * Issue: #90 (thumbnails-reload-on-folder-change)
 */
import { describe, expect, it, vi } from "vitest";

describe("mutation cooldown guard", () => {
  const COOLDOWN_MS = 1000;

  function makeCooldownGuard() {
    let lastMutationTime = 0;
    return {
      markLocalMutation() {
        lastMutationTime = Date.now();
      },
      shouldSkipSilentRefresh() {
        return Date.now() - lastMutationTime < COOLDOWN_MS;
      },
    };
  }

  it("allows silent refresh when no recent mutation", () => {
    const guard = makeCooldownGuard();
    expect(guard.shouldSkipSilentRefresh()).toBe(false);
  });

  it("blocks silent refresh immediately after local mutation", () => {
    const guard = makeCooldownGuard();
    guard.markLocalMutation();
    expect(guard.shouldSkipSilentRefresh()).toBe(true);
  });

  it("allows silent refresh after cooldown expires", () => {
    const guard = makeCooldownGuard();
    guard.markLocalMutation();

    vi.useFakeTimers();
    vi.advanceTimersByTime(COOLDOWN_MS + 1);
    expect(guard.shouldSkipSilentRefresh()).toBe(false);
    vi.useRealTimers();
  });

  it("resets cooldown on each mutation", () => {
    vi.useFakeTimers();
    const guard = makeCooldownGuard();
    guard.markLocalMutation();

    vi.advanceTimersByTime(COOLDOWN_MS - 100);
    expect(guard.shouldSkipSilentRefresh()).toBe(true);

    guard.markLocalMutation();
    vi.advanceTimersByTime(COOLDOWN_MS - 100);
    expect(guard.shouldSkipSilentRefresh()).toBe(true);

    vi.advanceTimersByTime(200);
    expect(guard.shouldSkipSilentRefresh()).toBe(false);
    vi.useRealTimers();
  });
});
