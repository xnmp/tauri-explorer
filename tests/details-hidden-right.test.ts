import { describe, expect, it } from "vitest";
import { hiddenRight } from "../src/lib/domain/details-hidden-right";

describe("hiddenRight", () => {
  it("is the content still hidden past the visible right edge", () => {
    expect(hiddenRight(1000, 0, 400)).toBe(600);
    expect(hiddenRight(1000, 300, 400)).toBe(300);
  });
  it("is zero when scrolled to the end or nothing overflows", () => {
    expect(hiddenRight(1000, 600, 400)).toBe(0);
    expect(hiddenRight(400, 0, 400)).toBe(0);
    expect(hiddenRight(300, 0, 400)).toBe(0);
  });
  it("tolerates fractional and non-finite input", () => {
    expect(hiddenRight(1000.4, 0.2, 400)).toBe(600);
    expect(hiddenRight(Number.NaN, 0, 400)).toBe(0);
  });
});
