/**
 * Title bar / pane tab strip visibility rules.
 * These functions drive TitleBar.svelte and PaneTabBar.svelte.
 * Issues: feat/integrated-titlebar, fix/titlebar-disabled-margin, #140 (per-pane tabs)
 */
import { describe, it, expect } from "vitest";
import { showTitleBar, showPaneTabBar } from "$lib/domain/titlebar";

describe("showTitleBar", () => {
  it("hides entirely with no controls and not integrated (Hyprland-style chrome-less)", () => {
    expect(showTitleBar(false, false)).toBe(false);
  });

  it("shows when window controls are enabled", () => {
    expect(showTitleBar(false, true)).toBe(true);
  });

  it("always shows when integrated", () => {
    expect(showTitleBar(true, false)).toBe(true);
    expect(showTitleBar(true, true)).toBe(true);
  });
});

describe("showPaneTabBar", () => {
  it("hides with a single tab in single-pane mode", () => {
    expect(showPaneTabBar(1, false)).toBe(false);
  });

  it("shows with multiple tabs", () => {
    expect(showPaneTabBar(2, false)).toBe(true);
  });

  it("always shows in dual-pane mode, even with one tab", () => {
    expect(showPaneTabBar(1, true)).toBe(true);
  });
});
