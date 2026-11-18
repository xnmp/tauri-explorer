/**
 * #1756: macOS windows always carry native traffic lights, so the custom
 * min/max/close set must never render there, whatever the setting says.
 */
import { describe, it, expect } from "vitest";
import { isMacPlatform } from "$lib/domain/platform";
import { effectiveWindowControls, showTabStrip, showTitleBar, titleRowHeldOpen } from "$lib/domain/titlebar";

const effective = (setting: boolean, platform: string | null | undefined) =>
  effectiveWindowControls(setting, isMacPlatform(platform));

describe("effectiveWindowControls", () => {
  it.each(["MacIntel", "MacARM", "Mac"])("is false on %s even when the setting is on", (platform) => {
    expect(effective(true, platform)).toBe(false);
    expect(effective(false, platform)).toBe(false);
  });

  it.each(["Win32", "Linux x86_64"])("follows the setting on %s", (platform) => {
    expect(effective(true, platform)).toBe(true);
    expect(effective(false, platform)).toBe(false);
  });

  it.each(["", "Plan9", null, undefined])("follows the setting on unknown platform %j", (platform) => {
    expect(effective(true, platform)).toBe(true);
    expect(effective(false, platform)).toBe(false);
  });

  it("does not let the controls hold the lone-tab row open on macOS", () => {
    const controls = effective(true, "MacIntel");
    expect(showTabStrip(1, false, controls)).toBe(false);
    expect(showTitleBar(false, controls, false)).toBe(false);
  });

  it("still holds the row open on Linux", () => {
    const controls = effective(true, "Linux x86_64");
    expect(showTabStrip(1, false, controls)).toBe(true);
    expect(showTitleBar(false, controls, false)).toBe(true);
  });

  // #1734: the integrated title bar row exists on macOS for the traffic
  // lights, so the lone tab stays in it; a Floating Islands window needs that
  // tab, because the active tab owns the top edge of its island.
  const loneTabVisible = (integratedTitleBar: boolean, setting: boolean, platform: string) =>
    showTabStrip(1, false, titleRowHeldOpen(integratedTitleBar, setting, isMacPlatform(platform)));

  it.each([true, false])("keeps the lone tab in the integrated macOS row (controls setting %s)", (setting) => {
    expect(loneTabVisible(true, setting, "MacIntel")).toBe(true);
    expect(showTitleBar(true, effective(setting, "MacIntel"), true)).toBe(true);
  });

  it("hides the lone tab on macOS when the native title bar replaces the row", () => {
    expect(loneTabVisible(false, true, "MacIntel")).toBe(false);
    expect(showTitleBar(false, effective(true, "MacIntel"), false)).toBe(false);
  });

  it("holds the row open for either reason, and only for those", () => {
    expect(titleRowHeldOpen(false, false, false)).toBe(false);
    expect(titleRowHeldOpen(true, false, false)).toBe(true);
    expect(titleRowHeldOpen(false, true, false)).toBe(true);
    expect(titleRowHeldOpen(false, true, true)).toBe(false);
    expect(loneTabVisible(false, true, "Linux x86_64")).toBe(true);
    expect(loneTabVisible(false, false, "Linux x86_64")).toBe(false);
  });
});
