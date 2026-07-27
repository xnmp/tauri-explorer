import { describe, expect, it } from "vitest";
import { compactRelativeTime } from "$lib/domain/relative-time";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("compactRelativeTime", () => {
  it("formats the compact labels used by date displays", () => {
    expect(compactRelativeTime(5 * MINUTE)).toBe("5m");
    expect(compactRelativeTime(3 * HOUR)).toBe("3h");
    expect(compactRelativeTime(5 * DAY)).toBe("5d");
    expect(compactRelativeTime(35 * DAY)).toBe("5w");
    expect(compactRelativeTime(150 * DAY)).toBe("5mo");
    expect(compactRelativeTime(400 * DAY)).toBe("1y");
  });

  it("pins day, week, month, and year transitions", () => {
    expect(compactRelativeTime(6 * DAY)).toBe("6d");
    expect(compactRelativeTime(7 * DAY)).toBe("1w");
    expect(compactRelativeTime(59 * DAY)).toBe("1mo");
    expect(compactRelativeTime(60 * DAY)).toBe("2mo");
    expect(compactRelativeTime(359 * DAY)).toBe("11mo");
    expect(compactRelativeTime(360 * DAY)).toBe("12mo");
    expect(compactRelativeTime(365 * DAY)).toBe("1y");
  });

  it("clamps future clock skew to now", () => {
    expect(compactRelativeTime(-5 * MINUTE)).toBe("now");
    expect(compactRelativeTime(0)).toBe("now");
  });
});
