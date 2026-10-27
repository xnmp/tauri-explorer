import { describe, it, expect } from "vitest";
import { PALETTE_PAGE_SIZE, clampedStep, pageKeyDelta } from "../src/lib/domain/palette-selection";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "altKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({
  key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods,
});

describe("clampedStep", () => {
  it("moves a full page in the middle of a long list", () => {
    expect(clampedStep(15, PALETTE_PAGE_SIZE, 100)).toBe(25);
    expect(clampedStep(15, -PALETTE_PAGE_SIZE, 100)).toBe(5);
  });
  it("clamps at the ends instead of wrapping", () => {
    expect(clampedStep(95, 10, 100)).toBe(99);
    expect(clampedStep(99, 10, 100)).toBe(99);
    expect(clampedStep(3, -10, 100)).toBe(0);
    expect(clampedStep(0, -10, 100)).toBe(0);
  });
  it("handles lists shorter than a page", () => {
    expect(clampedStep(0, 10, 4)).toBe(3);
    expect(clampedStep(3, -10, 4)).toBe(0);
  });
  it("handles single-row and empty lists", () => {
    expect(clampedStep(0, 10, 1)).toBe(0);
    expect(clampedStep(0, -10, 1)).toBe(0);
    expect(clampedStep(0, 10, 0)).toBe(0);
    expect(clampedStep(5, 10, 0)).toBe(0);
  });
});

describe("pageKeyDelta", () => {
  it("maps plain PageDown/PageUp to a page", () => {
    expect(pageKeyDelta(key("PageDown"))).toBe(10);
    expect(pageKeyDelta(key("PageUp"))).toBe(-10);
  });
  it("ignores other keys and modified presses", () => {
    expect(pageKeyDelta(key("ArrowDown"))).toBeNull();
    expect(pageKeyDelta(key("PageDown", { ctrlKey: true }))).toBeNull();
    expect(pageKeyDelta(key("PageUp", { shiftKey: true }))).toBeNull();
    expect(pageKeyDelta(key("PageUp", { altKey: true }))).toBeNull();
    expect(pageKeyDelta(key("PageDown", { metaKey: true }))).toBeNull();
  });
});
