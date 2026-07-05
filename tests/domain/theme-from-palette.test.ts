/**
 * Theme generation from image palettes (#203): light/dark selection,
 * accent legibility, CSS completeness, hostile inputs.
 */

import { describe, it, expect } from "vitest";
import {
  hexToRgb,
  rgbToHex,
  luminance,
  buildTheme,
  themeIdFromName,
} from "$lib/domain/theme-from-palette";

describe("buildTheme", () => {
  it("a dark dominant color produces a dark theme with light text", () => {
    const t = buildTheme(["#101418", "#5de5d5", "#333a44"], "img-x", "X")!;
    expect(t.dark).toBe(true);
    expect(t.css).toContain("color-scheme: dark");
    const text = hexToRgb(/--text-primary: (#[0-9a-f]{6})/.exec(t.css)![1])!;
    expect(luminance(text)).toBeGreaterThan(0.7);
  });

  it("a light dominant color produces a light theme with dark text", () => {
    const t = buildTheme(["#f2ead9", "#268bd2", "#c8b89a"], "img-y", "Y")!;
    expect(t.dark).toBe(false);
    expect(t.css).toContain("color-scheme: light");
    const text = hexToRgb(/--text-primary: (#[0-9a-f]{6})/.exec(t.css)![1])!;
    expect(luminance(text)).toBeLessThan(0.2);
  });

  it("the most saturated palette color drives the accent", () => {
    const t = buildTheme(["#181818", "#888888", "#ff2266"], "img-z", "Z")!;
    const accent = hexToRgb(/--accent: (#[0-9a-f]{6})/.exec(t.css)![1])!;
    // Reddish-pink family survives the legibility adjustment.
    expect(accent.r).toBeGreaterThan(accent.g);
  });

  it("defines every variable the theme engine's discovery scan requires", () => {
    const t = buildTheme(["#123456"], "img-w", "W")!;
    for (const required of ["--theme-name", "--background-solid", "--divider", "--accent"]) {
      expect(t.css).toContain(required);
    }
    expect(t.css).toContain(`[data-theme="img-w"]`);
  });

  it("survives a single-color palette and rejects an empty one", () => {
    expect(buildTheme(["#777777"], "img-s", "S")).not.toBeNull();
    expect(buildTheme([], "img-e", "E")).toBeNull();
    expect(buildTheme(["nonsense", "#zzz"], "img-b", "B")).toBeNull();
  });
});

describe("themeIdFromName", () => {
  it("sanitizes hostile image names into safe ids", () => {
    expect(themeIdFromName("My Wallpaper (final) 2.PNG")).toBe("img-my-wallpaper-final-2");
    expect(themeIdFromName("emoji-🍌🚀.png")).toBe("img-emoji");
    expect(themeIdFromName("....png")).toBe("img-theme");
    expect(themeIdFromName("x".repeat(100) + ".jpg").length).toBeLessThanOrEqual(44);
  });
});

describe("color primitives", () => {
  it("hex round-trips", () => {
    expect(rgbToHex(hexToRgb("#5de5d5")!)).toBe("#5de5d5");
  });
  it("rejects malformed hex", () => {
    expect(hexToRgb("#12")).toBeNull();
    expect(hexToRgb("red")).toBeNull();
  });
});
