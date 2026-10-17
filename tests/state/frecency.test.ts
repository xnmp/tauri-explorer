/**
 * Tests for frecency store (zoxide-style path ranking).
 * Issue: tauri-jrek
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { computeFrecencyScore, penalizeAccesses, frecencyStore } from "$lib/state/frecency.svelte";

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

describe("penalizeAccesses (downvote math)", () => {
  it("empties a single-access history", () => {
    expect(penalizeAccesses([Date.now()])).toEqual([]);
    expect(penalizeAccesses([])).toEqual([]);
  });

  it("keeps the older half and drops the recent (heaviest) accesses", () => {
    const now = Date.now();
    const accesses = [now - 4000, now - 3000, now - 2000, now - 1000]; // 4 entries
    const reduced = penalizeAccesses(accesses);
    expect(reduced).toEqual([now - 4000, now - 3000]); // oldest two kept
  });

  it("lowers the frecency score", () => {
    const now = Date.now();
    const accesses = [now - 2000, now - 1000, now];
    const before = computeFrecencyScore(accesses, now);
    const after = computeFrecencyScore(penalizeAccesses(accesses), now);
    expect(after).toBeLessThan(before);
  });

  it("is pure — does not mutate its input", () => {
    const now = Date.now();
    const accesses = [now - 3000, now - 2000, now - 1000, now];
    const snapshot = [...accesses];
    penalizeAccesses(accesses);
    expect(accesses).toEqual(snapshot);
  });

  it("normalises unsorted input to oldest-first before dropping", () => {
    const now = Date.now();
    const unsorted = [now - 1000, now - 4000, now - 2000, now - 3000];
    expect(penalizeAccesses(unsorted)).toEqual([now - 4000, now - 3000]);
  });
});

describe("frecencyStore.penalize (downvote + recovery)", () => {
  beforeEach(() => frecencyStore.clear());

  it("lowers the score without removing an entry that has history left", () => {
    const path = "/home/user/Projects";
    // Give it several accesses so penalize leaves some behind.
    for (let i = 0; i < 4; i++) frecencyStore.recordAccess(path);
    const before = frecencyStore.getScore(path);
    frecencyStore.penalize(path);
    const after = frecencyStore.getScore(path);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    expect(frecencyStore.entries).toHaveLength(1);
  });

  it("removes an entry that had only a single access", () => {
    const path = "/home/user/Once";
    frecencyStore.recordAccess(path);
    frecencyStore.penalize(path);
    expect(frecencyStore.entries).toHaveLength(0);
  });

  it("recovers: a downvoted path outranks its penalized score again after re-access", () => {
    const path = "/home/user/Recover";
    for (let i = 0; i < 4; i++) frecencyStore.recordAccess(path);
    frecencyStore.penalize(path);
    const penalized = frecencyStore.getScore(path);
    frecencyStore.recordAccess(path); // access it again
    const recovered = frecencyStore.getScore(path);
    expect(recovered).toBeGreaterThan(penalized);
  });

  it("matches the downvote key regardless of separator/case", () => {
    frecencyStore.recordAccess("C:\\Users\\chonw\\Pictures");
    frecencyStore.recordAccess("C:\\Users\\chonw\\Pictures");
    frecencyStore.penalize("c:/users/chonw/pictures");
    // Two accesses → penalize keeps one → entry survives with lower score.
    expect(frecencyStore.entries).toHaveLength(1);
    expect(frecencyStore.entries[0].accesses).toHaveLength(1);
  });

  it("is a no-op for an untracked path", () => {
    frecencyStore.recordAccess("/home/user/A");
    frecencyStore.penalize("/home/user/Unknown");
    expect(frecencyStore.entries).toHaveLength(1);
  });
});

describe("frecencyStore separator/case dedup", () => {
  beforeEach(() => frecencyStore.clear());

  it("treats slash/case variants of a Windows path as one entry (the Ctrl+P bug)", () => {
    frecencyStore.recordAccess("C:\\Users\\chonw\\Pictures");
    frecencyStore.recordAccess("C:\\Users\\chonw/Pictures"); // mixed slash
    frecencyStore.recordAccess("c:/users/chonw/pictures");   // forward + lowercase
    expect(frecencyStore.entries).toHaveLength(1);
  });

  it("looks up score by canonical key regardless of input separator/case", () => {
    frecencyStore.recordAccess("C:\\Users\\chonw\\Pictures");
    expect(frecencyStore.getScore("c:/users/chonw/pictures")).toBeGreaterThan(0);
    expect(frecencyStore.getScoreMap().get("c:/users/chonw/pictures")).toBeGreaterThan(0);
  });

  it("removes an entry regardless of the separator style used", () => {
    frecencyStore.recordAccess("C:\\Users\\chonw\\Pictures");
    frecencyStore.remove("c:/users/chonw/pictures");
    expect(frecencyStore.entries).toHaveLength(0);
  });
});

describe("frecencyStore.recordFileAction", () => {
  beforeEach(() => frecencyStore.clear());

  it("records the file's containing FOLDER, not the file path", () => {
    frecencyStore.recordFileAction("/home/user/Pictures/photo.jpg");
    expect(frecencyStore.entries).toHaveLength(1);
    expect(frecencyStore.entries[0].path).toBe("/home/user/Pictures");
  });

  it("coalesces actions on different files in the same folder into one entry", () => {
    frecencyStore.recordFileAction("/home/user/Pictures/a.jpg");
    frecencyStore.recordFileAction("/home/user/Pictures/b.png");
    expect(frecencyStore.entries).toHaveLength(1);
    expect(frecencyStore.entries[0].path).toBe("/home/user/Pictures");
    expect(frecencyStore.entries[0].accesses).toHaveLength(2);
  });
});
