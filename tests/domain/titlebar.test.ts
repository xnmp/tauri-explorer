/**
 * Title bar / tab strip visibility rules.
 * These functions drive TitleBar.svelte and WindowTabBar.svelte.
 * Issue: feat/integrated-titlebar, fix/titlebar-disabled-margin
 */
import { describe, it, expect } from "vitest";
import { showTabBar, showTitleBar, showTabArea } from "$lib/domain/titlebar";

describe("showTabBar", () => {
  it("shows with multiple tabs", () => {
    expect(showTabBar(false, 2)).toBe(true);
  });

  it("hides with a single tab when not integrated", () => {
    expect(showTabBar(false, 1)).toBe(false);
  });

  it("always shows when integrated title bar is on", () => {
    expect(showTabBar(true, 1)).toBe(true);
    expect(showTabBar(true, 0)).toBe(true);
  });
});

describe("showTitleBar", () => {
  it("hides entirely with one tab, no controls, not integrated (Hyprland-style chrome-less)", () => {
    expect(showTitleBar(false, 1, false)).toBe(false);
  });

  it("shows when window controls are enabled even with one tab", () => {
    expect(showTitleBar(false, 1, true)).toBe(true);
  });

  it("shows with multiple tabs regardless of controls", () => {
    expect(showTitleBar(false, 2, false)).toBe(true);
  });

  it("always shows when integrated", () => {
    expect(showTitleBar(true, 1, false)).toBe(true);
    expect(showTitleBar(true, 2, true)).toBe(true);
  });
});

describe("showTabArea", () => {
  it("matches title bar visibility in every configuration", () => {
    for (const integrated of [false, true]) {
      for (const tabs of [0, 1, 2, 5]) {
        for (const controls of [false, true]) {
          expect(
            showTabArea(integrated, tabs, controls),
            `integrated=${integrated} tabs=${tabs} controls=${controls}`,
          ).toBe(showTitleBar(integrated, tabs, controls));
        }
      }
    }
  });
});
