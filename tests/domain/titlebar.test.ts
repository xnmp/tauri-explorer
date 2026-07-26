/**
 * Title bar / tab strip visibility rules.
 * These functions drive TitleBar.svelte and WindowTabBar.svelte.
 * Issues: feat/integrated-titlebar, fix/titlebar-disabled-margin, #228 (window tabs)
 */
import { describe, it, expect } from "vitest";
import { showTitleBar, showWindowTabBar } from "$lib/domain/titlebar";

describe("showTitleBar", () => {
  it("hides entirely with no controls, not integrated, and no tab strip (Hyprland-style chrome-less)", () => {
    expect(showTitleBar(false, false, false)).toBe(false);
  });

  it("shows when window controls are enabled", () => {
    expect(showTitleBar(false, true, false)).toBe(true);
  });

  it("always shows when integrated", () => {
    expect(showTitleBar(true, false, false)).toBe(true);
    expect(showTitleBar(true, true, false)).toBe(true);
  });

  it("shows when the tab strip is visible even without controls (#229)", () => {
    expect(showTitleBar(false, false, true)).toBe(true);
  });
});

describe("showWindowTabBar", () => {
  it("hides with a single non-renameable tab", () => {
    expect(showWindowTabBar(1, false, false)).toBe(false);
  });

  it("shows with multiple tabs", () => {
    expect(showWindowTabBar(2, false, false)).toBe(true);
  });

  it("shows for a single renameable (multi-pane) tab so rename stays reachable", () => {
    expect(showWindowTabBar(1, true, false)).toBe(true);
  });

  // #504: the title bar row already renders to host the controls, so hiding
  // the lone tab saves no space and leaves the current folder unlabelled.
  it("shows a single non-renameable tab when window controls are enabled (#504)", () => {
    expect(showWindowTabBar(1, false, true)).toBe(true);
  });

  it("still hides the lone tab when window controls are disabled (chrome-less layout)", () => {
    expect(showWindowTabBar(1, false, false)).toBe(false);
  });

  it("keeps multiple tabs visible regardless of the window-controls setting", () => {
    expect(showWindowTabBar(2, false, true)).toBe(true);
    expect(showWindowTabBar(2, false, false)).toBe(true);
  });
});
