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
