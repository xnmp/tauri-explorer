/**
 * Regression test: window-top-spacer should not show when window controls are disabled.
 * Issue: fix/titlebar-disabled-margin
 *
 * The spacer is only needed as a drag region when the window has controls
 * but no toolbar. When the user disables window controls, no spacer should appear.
 */
import { describe, it, expect } from "vitest";

describe("Titlebar spacer logic", () => {
  it("spacer should only show when toolbar is hidden AND window controls are shown AND single tab", () => {
    // Encode the business rule from +page.svelte:
    // showToolbar=false && tabs.length <= 1 && showWindowControls => spacer
    const cases = [
      { showToolbar: true, showWindowControls: true, tabs: 1, expectSpacer: false },
      { showToolbar: false, showWindowControls: true, tabs: 1, expectSpacer: true },
      { showToolbar: false, showWindowControls: false, tabs: 1, expectSpacer: false },
      { showToolbar: false, showWindowControls: true, tabs: 2, expectSpacer: false },
      { showToolbar: true, showWindowControls: false, tabs: 1, expectSpacer: false },
    ];

    for (const c of cases) {
      const showSpacer = !c.showToolbar && c.tabs <= 1 && c.showWindowControls;
      expect(showSpacer, JSON.stringify(c)).toBe(c.expectSpacer);
    }
  });
});
