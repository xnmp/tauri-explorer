import { describe, expect, it } from "vitest";
import { millerHoistedToIsland } from "$lib/domain/miller-placement";

describe("millerHoistedToIsland (#434, #1699)", () => {
  const base = { islands: true, showSidebar: false, multiPane: false };

  it("hoists a single pane's columns in island mode without a sidebar", () => {
    expect(millerHoistedToIsland(base)).toBe(true);
  });

  it("never hoists in a split tab, so pane focus cannot move the columns", () => {
    expect(millerHoistedToIsland({ ...base, multiPane: true })).toBe(false);
  });

  it("keeps columns inline when the sidebar occupies the left island", () => {
    expect(millerHoistedToIsland({ ...base, showSidebar: true })).toBe(false);
  });

  it("keeps columns inline outside the island arrangement", () => {
    expect(millerHoistedToIsland({ ...base, islands: false })).toBe(false);
    expect(millerHoistedToIsland({ islands: false, showSidebar: true, multiPane: true })).toBe(false);
  });
});
