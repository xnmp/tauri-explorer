import { describe, it, expect } from "vitest";
import { gitStatusLetter } from "../../src/lib/domain/git";

describe("gitStatusLetter", () => {
  it("returns M for Modified", () => {
    expect(gitStatusLetter("Modified")).toBe("M");
  });

  it("returns A for Added", () => {
    expect(gitStatusLetter("Added")).toBe("A");
  });

  it("returns D for Deleted", () => {
    expect(gitStatusLetter("Deleted")).toBe("D");
  });

  it("returns R for Renamed", () => {
    expect(gitStatusLetter("Renamed")).toBe("R");
  });

  it("returns C for Copied", () => {
    expect(gitStatusLetter("Copied")).toBe("C");
  });

  it("returns U for Untracked", () => {
    expect(gitStatusLetter("Untracked")).toBe("U");
  });

  it("returns I for Ignored", () => {
    expect(gitStatusLetter("Ignored")).toBe("I");
  });

  it("returns ! for Conflict", () => {
    expect(gitStatusLetter("Conflicted")).toBe("!");
  });

  it("returns T for TypeChange", () => {
    expect(gitStatusLetter("TypeChange")).toBe("T");
  });

  it("returns ? for unknown status", () => {
    expect(gitStatusLetter("SomethingElse")).toBe("?");
  });

  it("returns ? for empty string", () => {
    expect(gitStatusLetter("")).toBe("?");
  });
});

describe("relativeTimeToday (#389)", () => {
  // Fixed "now": 2026-07-14 15:00 local time.
  const now = new Date(2026, 6, 14, 15, 0, 0).getTime();
  const at = (h: number, m: number) => new Date(2026, 6, 14, h, m, 0).getTime() / 1000;

  it("renders ages for commits made today", async () => {
    const { relativeTimeToday } = await import("$lib/domain/git");
    expect(relativeTimeToday(at(14, 59), now)).toBe("1 minute ago");
    expect(relativeTimeToday(at(14, 55), now)).toBe("5 minutes ago");
    expect(relativeTimeToday(at(10, 0), now)).toBe("5 hours ago");
    expect(relativeTimeToday(at(14, 0), now)).toBe("1 hour ago");
  });

  it("says 'just now' under a minute and for future skew", async () => {
    const { relativeTimeToday } = await import("$lib/domain/git");
    expect(relativeTimeToday(now / 1000 - 30, now)).toBe("just now");
    expect(relativeTimeToday(now / 1000 + 120, now)).toBe("just now");
  });

  it("returns null for other days (caller falls back to the date)", async () => {
    const { relativeTimeToday } = await import("$lib/domain/git");
    const yesterday = new Date(2026, 6, 13, 23, 59, 0).getTime() / 1000;
    expect(relativeTimeToday(yesterday, now)).toBeNull();
    const lastYear = new Date(2025, 6, 14, 15, 0, 0).getTime() / 1000;
    expect(relativeTimeToday(lastYear, now)).toBeNull();
  });
});

describe("compactRelativeTimeToday (#458)", () => {
  // Fixed "now": 2026-07-14 15:00 local time.
  const now = new Date(2026, 6, 14, 15, 0, 0).getTime();
  const nowSec = now / 1000;

  it("renders 'now' at the 0s and 59s boundaries and for future skew", async () => {
    const { compactRelativeTimeToday } = await import("$lib/domain/git");
    expect(compactRelativeTimeToday(nowSec, now)).toBe("now");
    expect(compactRelativeTimeToday(nowSec - 59, now)).toBe("now");
    // Clock skew: a commit "in the future" reads as now, not a negative age.
    expect(compactRelativeTimeToday(nowSec + 120, now)).toBe("now");
  });

  it("switches to minutes at 60s and holds through 59m", async () => {
    const { compactRelativeTimeToday } = await import("$lib/domain/git");
    expect(compactRelativeTimeToday(nowSec - 60, now)).toBe("1m");
    expect(compactRelativeTimeToday(nowSec - 59 * 60, now)).toBe("59m");
  });

  it("switches to hours at 1h and holds through 23h (same day)", async () => {
    const { compactRelativeTimeToday } = await import("$lib/domain/git");
    // 1h ago: 14:00, still today.
    expect(compactRelativeTimeToday(new Date(2026, 6, 14, 14, 0, 0).getTime() / 1000, now)).toBe("1h");
    // 15h ago: 00:00, still today's calendar day.
    expect(compactRelativeTimeToday(new Date(2026, 6, 14, 0, 0, 0).getTime() / 1000, now)).toBe("15h");
  });

  it("returns null for other calendar days", async () => {
    const { compactRelativeTimeToday } = await import("$lib/domain/git");
    // Yesterday 23:59 — under 24h old but a different calendar day.
    expect(compactRelativeTimeToday(new Date(2026, 6, 13, 23, 59, 0).getTime() / 1000, now)).toBeNull();
    expect(compactRelativeTimeToday(new Date(2025, 6, 14, 15, 0, 0).getTime() / 1000, now)).toBeNull();
  });

  it("returns null for malformed / far-past timestamps", async () => {
    const { compactRelativeTimeToday } = await import("$lib/domain/git");
    expect(compactRelativeTimeToday(NaN, now)).toBeNull();
    // Epoch and a large negative timestamp are not today.
    expect(compactRelativeTimeToday(0, now)).toBeNull();
    expect(compactRelativeTimeToday(-1_000_000, now)).toBeNull();
  });
});
