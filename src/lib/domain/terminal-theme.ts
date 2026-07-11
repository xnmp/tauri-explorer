/**
 * Maps the app's CSS theme variables onto an xterm.js theme object
 * (issue #139). Pure: callers supply `resolve`, which turns a CSS variable
 * name into a *computed* color string ("" when unset) — in the app that's a
 * probe element inside the theme cascade, in tests a lookup table. xterm
 * doesn't consume CSS variables natively, so this runs on every theme switch
 * and the result is pushed into `Terminal.options.theme`.
 */

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground?: string;
}

/**
 * Re-emit a computed CSS color with the given alpha. Accepts rgb()/rgba()
 * (what getComputedStyle produces) and #rgb/#rrggbb hex; returns undefined
 * for anything unparseable so callers can omit the property.
 */
export function withAlpha(color: string, alpha: number): string | undefined {
  const rgbMatch = color.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/
  );
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const num = parseInt(hex, 16);
    return `rgba(${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
  }
  return undefined;
}

/**
 * Build the xterm theme from the active app theme.
 * Backgrounds use --background-solid (not --content-bg, which may be a
 * gradient xterm can't render); selection is the accent at low alpha.
 * The ANSI 16-color palette is left to xterm's defaults, which read fine on
 * both light and dark solid backgrounds.
 */
export function buildTerminalTheme(resolve: (varName: string) => string): TerminalTheme {
  const solid = resolve("--background-solid") || "#1c1c1e";
  const foreground = resolve("--text-primary") || "#e8e8ed";
  const accent = resolve("--accent") || "#4cc2f4";

  return {
    background: solid,
    foreground,
    cursor: accent,
    cursorAccent: solid,
    selectionBackground: withAlpha(accent, 0.35),
  };
}
