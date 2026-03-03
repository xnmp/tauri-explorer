/**
 * Tests for frecency store (zoxide-style path ranking).
 * Issue: tauri-jrek
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { computeFrecencyScore } from "$lib/state/frecency.svelte";

describe("computeFrecencyScore", () => {
  it("returns 0 for empty accesses", () => {
    expect(computeFrecencyScore([], Date.now())).toBe(0);
  });

  it("returns ~1.0 for a single access right now", () => {
    const now = Date.now();
    const score = computeFrecencyScore([now], now);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("returns ~0.5 for a single access 1 hour ago", () => {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const score = computeFrecencyScore([oneHourAgo], now);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("returns ~0.04 for a single access 24 hours ago", () => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 3_600_000;
    const score = computeFrecencyScore([oneDayAgo], now);
    expect(score).toBeCloseTo(1 / 25, 5); // 1/(24+1) = 0.04
  });

  it("sums scores across multiple accesses", () => {
    const now = Date.now();
    const accesses = [now, now - 3_600_000]; // now and 1 hour ago
    const score = computeFrecencyScore(accesses, now);
    // 1/(0+1) + 1/(1+1) = 1.0 + 0.5 = 1.5
    expect(score).toBeCloseTo(1.5, 5);
  });

  it("recent accesses dominate old ones", () => {
    const now = Date.now();
    const recentScore = computeFrecencyScore([now, now - 1000], now);
    const oldScore = computeFrecencyScore([now - 48 * 3_600_000, now - 72 * 3_600_000], now);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("more accesses increase score", () => {
    const now = Date.now();
    const singleAccess = computeFrecencyScore([now], now);
    const multipleAccesses = computeFrecencyScore([now, now - 1000, now - 2000], now);
    expect(multipleAccesses).toBeGreaterThan(singleAccess);
  });

  it("handles future timestamps gracefully (clamped to 0 hours)", () => {
    const now = Date.now();
    const future = now + 10_000;
    const score = computeFrecencyScore([future], now);
    // Math.max(0, ...) clamps negative to 0, so 1/(0+1) = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });
});
