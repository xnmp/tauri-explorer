import { describe, expect, it } from "vitest";
import {
  NUMERIC_SETTINGS,
  RECENT_ITEMS_COUNT_PRESETS,
  isValidNumericSetting,
  recentItemsCountChoices,
} from "$lib/domain/settings-numbers";

describe("recentItemsCountChoices (#1661)", () => {
  it("offers the presets in ascending order, each a valid saved count", () => {
    expect(recentItemsCountChoices(5)).toEqual([3, 5, 10, 15, 20]);
    for (const n of RECENT_ITEMS_COUNT_PRESETS) {
      expect(isValidNumericSetting(NUMERIC_SETTINGS.recentItemsCount, n)).toBe(true);
    }
  });

  it("includes a custom saved count so the current value can be checked", () => {
    expect(recentItemsCountChoices(6)).toEqual([3, 5, 6, 10, 15, 20]);
    expect(recentItemsCountChoices(1)).toEqual([1, 3, 5, 10, 15, 20]);
  });

  it("never offers hiding or out-of-range values from the header menu", () => {
    expect(recentItemsCountChoices(0)).toEqual([3, 5, 10, 15, 20]);
    expect(recentItemsCountChoices(99)).toEqual([3, 5, 10, 15, 20]);
    expect(recentItemsCountChoices(2.5)).toEqual([3, 5, 10, 15, 20]);
  });
});
