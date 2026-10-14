import { describe, expect, it } from "vitest";
import { formatResolution } from "$lib/domain/file";

describe("formatResolution (#1118)", () => {
  it("formats width × height in pixels", () => {
    expect(formatResolution(1920, 1080)).toBe("1920 × 1080");
  });
  it("omits unknown dimensions", () => {
    expect(formatResolution(0, 0)).toBe("");
    expect(formatResolution(NaN, 10)).toBe("");
    expect(formatResolution(10, -1)).toBe("");
  });
});
