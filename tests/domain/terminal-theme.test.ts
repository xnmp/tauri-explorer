/**
 * Tests for the terminal theme mapping (issue #139): app CSS variables →
 * xterm.js theme object.
 */

import { describe, it, expect } from "vitest";
import { buildTerminalTheme, compositeOver, withAlpha } from "$lib/domain/terminal-theme";

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

describe("compositeOver", () => {
  it("blends a translucent color over an opaque base", () => {
    expect(compositeOver("rgba(44, 44, 46, 0.6)", "#1c1c1e")).toBe("rgb(38, 38, 40)");
  });

  it("returns an opaque top color unchanged (as rgb)", () => {
    expect(compositeOver("#336699", "rgb(0, 0, 0)")).toBe("rgb(51, 102, 153)");
  });

  it("keeps the base when either color is unparseable", () => {
    expect(compositeOver("linear-gradient(red, blue)", "#1c1c1e")).toBe("#1c1c1e");
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

describe("buildTerminalTheme matches the app theme (#1651)", () => {
  const darkTheme: Record<string, string> = {
    "--background-solid": "rgb(28, 28, 30)",
    "--background-card": "rgba(44, 44, 46, 0.6)",
    "--text-primary": "rgb(232, 232, 237)",
    "--text-secondary": "rgb(152, 152, 157)",
    "--text-tertiary": "rgb(110, 110, 115)",
    "--accent": "rgb(76, 194, 244)",
    "--system-critical": "rgb(255, 107, 107)",
    "--system-success": "rgb(105, 219, 124)",
    "--system-caution": "rgb(255, 212, 59)",
  };
  const lightTheme: Record<string, string> = {
    "--background-solid": "rgb(245, 245, 247)",
    "--background-card": "rgba(255, 255, 255, 0.72)",
    "--text-primary": "rgb(26, 26, 26)",
    "--text-secondary": "rgb(96, 96, 96)",
    "--text-tertiary": "rgb(140, 140, 140)",
    "--accent": "rgb(0, 95, 184)",
    "--system-critical": "rgb(196, 43, 28)",
    "--system-success": "rgb(15, 123, 15)",
    "--system-caution": "rgb(157, 93, 0)",
  };
  const from = (vars: Record<string, string>) => (name: string) => vars[name] ?? "";

  it("paints the background in the panes' card surface, not the bare window base", () => {
    const theme = buildTerminalTheme(from(darkTheme));
    expect(theme.background).toBe("rgb(38, 38, 40)");
    expect(theme.cursorAccent).toBe(theme.background);
  });

  it("colors ANSI status hues from the theme's status colors and accent", () => {
    const theme = buildTerminalTheme(from(darkTheme));
    expect(theme.red).toBe(darkTheme["--system-critical"]);
    expect(theme.green).toBe(darkTheme["--system-success"]);
    expect(theme.yellow).toBe(darkTheme["--system-caution"]);
    expect(theme.blue).toBe(darkTheme["--accent"]);
    // Bold/bright output keeps the theme hue.
    expect(theme.brightRed).toBe(darkTheme["--system-critical"]);
    // Nothing the theme doesn't define is invented: xterm keeps its default.
    expect(theme.magenta).toBeUndefined();
    expect(theme.white).toBeUndefined();
  });

  it("keeps black and white readable on light backgrounds", () => {
    const theme = buildTerminalTheme(from(lightTheme));
    expect(theme.background).toBe("rgb(252, 252, 253)");
    expect(theme.black).toBe(lightTheme["--text-primary"]);
    expect(theme.brightBlack).toBe(lightTheme["--text-secondary"]);
    expect(theme.white).toBe(lightTheme["--text-tertiary"]);
    expect(theme.brightWhite).toBe(lightTheme["--text-secondary"]);
  });

  it("lets a theme pin its own terminal palette", () => {
    const theme = buildTerminalTheme(from({
      ...darkTheme,
      "--terminal-background": "rgb(51, 51, 51)",
      "--terminal-foreground": "rgb(255, 255, 255)",
      "--terminal-red": "rgb(255, 43, 43)",
      "--terminal-bright-red": "rgb(255, 85, 85)",
      "--terminal-magenta": "rgb(255, 222, 173)",
    }));
    expect(theme.background).toBe("rgb(51, 51, 51)");
    expect(theme.foreground).toBe("rgb(255, 255, 255)");
    expect(theme.red).toBe("rgb(255, 43, 43)");
    expect(theme.brightRed).toBe("rgb(255, 85, 85)");
    expect(theme.magenta).toBe("rgb(255, 222, 173)");
    expect(theme.brightMagenta).toBe("rgb(255, 222, 173)");
  });
});
