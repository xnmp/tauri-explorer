/**
 * #504: the tab strip must stay visible with a single tab while the native
 * window controls are enabled.
 *
 * The window controls already hold the title bar row open, so hiding the lone
 * tab saves no vertical space — it just leaves the folder the user is looking
 * at unlabelled. This clause was fixed once inline in WindowTabBar.svelte
 * (5ca49d76) and lost when #140 extracted the rules into domain/titlebar.ts;
 * these cases pin each clause independently so the next extraction cannot drop
 * one silently.
 */
import { describe, it, expect } from "vitest";
import { showTabStrip, showWindowTabBar } from "$lib/domain/titlebar";

describe("showTabStrip", () => {
  it("shows a single non-renameable tab when window controls are enabled", () => {
    expect(showTabStrip(1, false, true)).toBe(true);
  });

  it("hides a single non-renameable tab when window controls are disabled", () => {
    // The chrome-less layout (tiling WMs) is unchanged: no row, no strip.
    expect(showTabStrip(1, false, false)).toBe(false);
  });

  it("keeps multiple tabs visible regardless of the window-controls setting", () => {
    expect(showTabStrip(2, false, true)).toBe(true);
    expect(showTabStrip(2, false, false)).toBe(true);
  });

  it("keeps a renameable single tab visible regardless of the setting", () => {
    // Multi-pane rename affordance must stay reachable either way.
    expect(showTabStrip(1, true, true)).toBe(true);
    expect(showTabStrip(1, true, false)).toBe(true);
  });

  it("agrees with the strip's intrinsic rule whenever controls are off", () => {
    // With controls off the composed rule must reduce EXACTLY to the strip's
    // own reasons — the new clause may only ever add visibility, never remove.
    for (const tabCount of [0, 1, 2, 5]) {
      for (const renameable of [false, true]) {
        expect(showTabStrip(tabCount, renameable, false)).toBe(
          showWindowTabBar(tabCount, renameable),
        );
        expect(showTabStrip(tabCount, renameable, true)).toBe(true);
      }
    }
  });
});
