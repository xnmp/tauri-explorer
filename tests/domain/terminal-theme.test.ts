/**
 * Tests for the terminal theme mapping (issue #139): app CSS variables →
 * xterm.js theme object.
 */

import { describe, it, expect } from "vitest";
import { buildTerminalTheme, withAlpha } from "$lib/domain/terminal-theme";

describe("withAlpha", () => {
  it("converts rgb() to rgba() with the requested alpha", () => {
    expect(withAlpha("rgb(76, 194, 244)", 0.35)).toBe("rgba(76, 194, 244, 0.35)");
  });

  it("replaces the alpha of an rgba() input", () => {
    expect(withAlpha("rgba(10, 20, 30, 0.9)", 0.5)).toBe("rgba(10, 20, 30, 0.5)");
  });

  it("converts 6- and 3-digit hex", () => {
    expect(withAlpha("#4cc2f4", 0.2)).toBe("rgba(76, 194, 244, 0.2)");
    expect(withAlpha("#fff", 1)).toBe("rgba(255, 255, 255, 1)");
  });

  it("returns undefined for unparseable input", () => {
    expect(withAlpha("", 0.5)).toBeUndefined();
    expect(withAlpha("color-mix(in srgb, red, blue)", 0.5)).toBeUndefined();
    expect(withAlpha("transparent", 0.5)).toBeUndefined();
  });
});

describe("buildTerminalTheme", () => {
  const vars: Record<string, string> = {
    "--background-solid": "rgb(28, 28, 30)",
    "--text-primary": "rgb(232, 232, 237)",
    "--accent": "rgb(76, 194, 244)",
  };
  const resolve = (name: string) => vars[name] ?? "";

  it("maps theme variables to xterm colors", () => {
    const theme = buildTerminalTheme(resolve);
    expect(theme.background).toBe("rgb(28, 28, 30)");
    expect(theme.foreground).toBe("rgb(232, 232, 237)");
    expect(theme.cursor).toBe("rgb(76, 194, 244)");
    // Cursor text renders in the background color for contrast.
    expect(theme.cursorAccent).toBe("rgb(28, 28, 30)");
    expect(theme.selectionBackground).toBe("rgba(76, 194, 244, 0.35)");
  });

  it("falls back to readable defaults when variables are missing", () => {
    const theme = buildTerminalTheme(() => "");
    expect(theme.background).toBe("#1c1c1e");
    expect(theme.foreground).toBe("#e8e8ed");
    expect(theme.cursor).toBe("#4cc2f4");
    expect(theme.selectionBackground).toBe("rgba(76, 194, 244, 0.35)");
  });

  it("omits selection when the accent cannot be parsed", () => {
    const theme = buildTerminalTheme((n) =>
      n === "--accent" ? "color-mix(in srgb, red, blue)" : ""
    );
    expect(theme.selectionBackground).toBeUndefined();
  });
});
