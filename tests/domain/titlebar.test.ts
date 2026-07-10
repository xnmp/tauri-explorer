/**
 * Title bar / tab strip visibility rules.
 * These functions drive TitleBar.svelte and WindowTabBar.svelte.
 * Issues: feat/integrated-titlebar, fix/titlebar-disabled-margin, #228 (window tabs)
 */
import { describe, it, expect } from "vitest";
import { showTitleBar, showWindowTabBar } from "$lib/domain/titlebar";

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

describe("showWindowTabBar", () => {
  it("hides with a single non-renameable tab", () => {
    expect(showWindowTabBar(1, false)).toBe(false);
  });

  it("shows with multiple tabs", () => {
    expect(showWindowTabBar(2, false)).toBe(true);
  });

  it("shows for a single renameable (multi-pane) tab so rename stays reachable", () => {
    expect(showWindowTabBar(1, true)).toBe(true);
  });
});
