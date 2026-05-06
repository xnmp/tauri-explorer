/**
 * Tests for integratedTitleBar setting visibility logic.
 * When enabled, the title bar and tab bar should always show,
 * regardless of tab count or window controls setting.
 */
import { describe, it, expect } from "vitest";

describe("Integrated title bar visibility logic", () => {
  it("title bar always shows when integratedTitleBar is true", () => {
    const cases = [
      { integratedTitleBar: false, tabs: 1, showWindowControls: false, expectTitleBar: false },
      { integratedTitleBar: false, tabs: 1, showWindowControls: true, expectTitleBar: true },
      { integratedTitleBar: false, tabs: 2, showWindowControls: false, expectTitleBar: true },
      { integratedTitleBar: true, tabs: 1, showWindowControls: false, expectTitleBar: true },
      { integratedTitleBar: true, tabs: 1, showWindowControls: true, expectTitleBar: true },
      { integratedTitleBar: true, tabs: 2, showWindowControls: false, expectTitleBar: true },
    ];

    for (const c of cases) {
      const showTabBar = c.integratedTitleBar || c.tabs > 1;
      const showTitleBar = c.integratedTitleBar || showTabBar || c.showWindowControls;
      expect(showTitleBar, JSON.stringify(c)).toBe(c.expectTitleBar);
    }
  });

  it("tab area always shows when integratedTitleBar is true", () => {
    const cases = [
      { integratedTitleBar: false, tabs: 1, showWindowControls: false, expectTabArea: false },
      { integratedTitleBar: false, tabs: 1, showWindowControls: true, expectTabArea: true },
      { integratedTitleBar: false, tabs: 2, showWindowControls: false, expectTabArea: true },
      { integratedTitleBar: true, tabs: 1, showWindowControls: false, expectTabArea: true },
      { integratedTitleBar: true, tabs: 1, showWindowControls: true, expectTabArea: true },
    ];

    for (const c of cases) {
      const showTabArea = c.integratedTitleBar || c.tabs > 1 || c.showWindowControls;
      expect(showTabArea, JSON.stringify(c)).toBe(c.expectTabArea);
    }
  });
});
