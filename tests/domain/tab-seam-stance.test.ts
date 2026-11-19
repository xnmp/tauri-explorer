import { describe, expect, it } from "vitest";
import { stripShownView, tabFootHole, tabPresence } from "$lib/domain/tab-seam";

describe("tabPresence", () => {
  it("is zero up to 2px, rises over the next 16px, and is whole from 18px", () => {
    expect(tabPresence(0)).toBe(0);
    expect(tabPresence(2)).toBe(0);
    expect(tabPresence(10)).toBe(0.5);
    expect(tabPresence(18)).toBe(1);
    expect(tabPresence(400)).toBe(1);
  });

  it("a malformed width shows nothing", () => {
    expect(tabPresence(Number.NaN)).toBe(0);
    expect(tabPresence(-5)).toBe(0);
  });
});

describe("stripShownView", () => {
  const view = { left: 100, right: 600 };

  it("an unfaded viewport shows tabs across its whole width", () => {
    expect(stripShownView(view, { start: false, end: false }, 39)).toEqual(view);
  });

  it("each faded end hides its transparent run", () => {
    expect(stripShownView(view, { start: true, end: false }, 39)).toEqual({ left: 139, right: 600 });
    expect(stripShownView(view, { start: false, end: true }, 39)).toEqual({ left: 100, right: 561 });
    expect(stripShownView(view, { start: true, end: true }, 39)).toEqual({ left: 139, right: 561 });
  });

  it("a negative or malformed run hides nothing", () => {
    expect(stripShownView(view, { start: true, end: true }, -10)).toEqual(view);
    expect(stripShownView(view, { start: true, end: true }, Number.NaN)).toEqual(view);
  });
});

const island = (left: number, right: number, structural: boolean, name: string) =>
  ({ left, right, radius: 10, structural, name });

describe("tabFootHole", () => {
  it("clamps the hole to the viewport on each side", () => {
    expect(tabFootHole({ left: 10, right: 90 }, { left: 0, right: 100 })).toEqual({ left: 10, right: 90 });
    expect(tabFootHole({ left: -20, right: 90 }, { left: 0, right: 100 })).toEqual({ left: 0, right: 90 });
    expect(tabFootHole({ left: 10, right: 140 }, { left: 0, right: 100 })).toEqual({ left: 10, right: 100 });
  });
});
