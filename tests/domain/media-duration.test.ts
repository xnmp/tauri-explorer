import { describe, expect, it } from "vitest";
import { formatMediaDuration, mediaDurationRevision } from "$lib/domain/media-duration";

describe("formatMediaDuration (#995)", () => {
  it("uses m:ss below one hour", () => {
    expect(formatMediaDuration(0.4)).toBe("0:00");
    expect(formatMediaDuration(5)).toBe("0:05");
    expect(formatMediaDuration(754.9)).toBe("12:34");
    expect(formatMediaDuration(3599)).toBe("59:59");
  });

  it("uses h:mm:ss at one hour or longer", () => {
    expect(formatMediaDuration(3600)).toBe("1:00:00");
    expect(formatMediaDuration(3725)).toBe("1:02:05");
  });

  it("is empty when the duration is unknown or unreadable", () => {
    for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatMediaDuration(value)).toBe("");
    }
  });
});

describe("mediaDurationRevision (#995)", () => {
  it("changes when size or modified time changes", () => {
    const base = mediaDurationRevision({ size: 10, modified: "2026-01-01T00:00:00Z" });
    expect(mediaDurationRevision({ size: 10, modified: "2026-01-01T00:00:00Z" })).toBe(base);
    expect(mediaDurationRevision({ size: 11, modified: "2026-01-01T00:00:00Z" })).not.toBe(base);
    expect(mediaDurationRevision({ size: 10, modified: "2026-01-01T00:00:01Z" })).not.toBe(base);
  });
});
