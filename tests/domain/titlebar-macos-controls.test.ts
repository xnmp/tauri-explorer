/**
 * #1756: macOS windows always carry native traffic lights, so the custom
 * min/max/close set must never render there, whatever the setting says.
 */
import { describe, it, expect } from "vitest";
import { isMacPlatform } from "$lib/domain/platform";
import { effectiveWindowControls, showTabStrip, showTitleBar } from "$lib/domain/titlebar";

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
});
