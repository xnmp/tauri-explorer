/**
 * Update-check throttle (#185): at most one check per day, resilient to
 * missing or corrupted persisted state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { shouldCheckForUpdate, markUpdateChecked } from "$lib/api/update";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("update check throttle", () => {
  beforeEach(() => localStorage.clear());

  it("checks when never checked before", () => {
    expect(shouldCheckForUpdate()).toBe(true);
  });

  it("does not re-check within a day", () => {
    const now = 1_700_000_000_000;
    markUpdateChecked(now);
    expect(shouldCheckForUpdate(now + DAY_MS - 1)).toBe(false);
  });

  it("re-checks after a day", () => {
    const now = 1_700_000_000_000;
    markUpdateChecked(now);
    expect(shouldCheckForUpdate(now + DAY_MS)).toBe(true);
  });

  it("treats corrupted stored state as never-checked", () => {
    localStorage.setItem("updateCheck.lastCheckedAt", "not-a-number");
    expect(shouldCheckForUpdate()).toBe(true);
  });
});
