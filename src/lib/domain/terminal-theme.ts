/**
 * Maps the app's CSS theme variables onto an xterm.js theme object
 * (issue #139, #1651). Pure: callers supply `resolve`, which turns a CSS
 * variable name into a *computed* color string ("" when unset) — in the app
 * that's a probe element inside the theme cascade, in tests a lookup table.
 * xterm doesn't consume CSS variables natively, so this runs on every theme
 * switch and the result is pushed into `Terminal.options.theme`.
 */

export const ANSI_COLOR_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
] as const;
export type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number];
type BrightAnsiColorName = `bright${Capitalize<AnsiColorName>}`;

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground?: string;
} & Partial<Record<AnsiColorName | BrightAnsiColorName, string>>;

interface Rgba { r: number; g: number; b: number; a: number }

/** Parse a computed rgb()/rgba() or #rgb/#rrggbb color; undefined otherwise. */
export function parseColor(color: string): Rgba | undefined {
  const rgbMatch = color.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/
  );
  if (rgbMatch) {
    const [, r, g, b, a] = rgbMatch;
    return { r: Number(r), g: Number(g), b: Number(b), a: a === undefined ? 1 : Number(a) };
  }
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const num = parseInt(hex, 16);
    return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff, a: 1 };
  }
  return undefined;
}

/**
 * Re-emit a computed CSS color with the given alpha. Accepts rgb()/rgba()
 * (what getComputedStyle produces) and #rgb/#rrggbb hex; returns undefined
 * for anything unparseable so callers can omit the property.
 */
export function withAlpha(color: string, alpha: number): string | undefined {
  const c = parseColor(color);
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` : undefined;
}

/**
 * Paint a (possibly translucent) color over an opaque base and return the
 * opaque result as rgb(). Returns `base` unchanged when either is unparseable.
 */
export function compositeOver(top: string, base: string): string {
  const t = parseColor(top);
  const b = parseColor(base);
  if (!t || !b) return base;
  const mix = (x: number, y: number) => Math.round(x * t.a + y * (1 - t.a));
  return `rgb(${mix(t.r, b.r)}, ${mix(t.g, b.g)}, ${mix(t.b, b.b)})`;
}

/** WCAG relative luminance, for picking light/dark fallbacks. */
function isLight(color: string): boolean {
  const c = parseColor(color);
  if (!c) return false;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b) > 0.5;
}

/**
 * Semantic fallbacks for the ANSI colors a theme does not set explicitly
 * through `--terminal-<name>`. Status colors and the accent already have
 * contrast against the theme's surfaces, so error/success/warning output
 * reads in the same hues as the rest of the app.
 */
const SEMANTIC_ANSI: Partial<Record<AnsiColorName, string>> = {
  red: "--system-critical",
  green: "--system-success",
  yellow: "--system-caution",
  blue: "--accent",
};

/**
 * On light backgrounds xterm's default black/white pair is unreadable
 * (white text vanishes), so use the theme's text ramp: [normal, bright].
 */
const LIGHT_BACKGROUND_ANSI: Partial<Record<AnsiColorName, [string, string]>> = {
  black: ["--text-primary", "--text-secondary"],
  white: ["--text-tertiary", "--text-secondary"],
};

/**
 * Build the xterm theme from the active app theme.
 *
 * The background is the file panes' card surface composited over the solid
 * theme base, so the terminal is the same colour as the content it sits
 * under (#1651); xterm can't paint gradients or translucent layers.
 * Selection is the accent at low alpha.
 *
 * ANSI colors: a theme may pin any of the 16 with `--terminal-<name>` /
 * `--terminal-bright-<name>`. Otherwise red/green/yellow/blue follow the
 * theme's status colors and accent; black/white follow the text colors on
 * light backgrounds (xterm's defaults are near-invisible there). Anything
 * left unset uses xterm's default palette. Bright variants fall back to
 * their normal counterpart so a theme's hue is kept for bold output.
 */
export function buildTerminalTheme(resolve: (varName: string) => string): TerminalTheme {
  const solid = resolve("--background-solid") || "#1c1c1e";
  const card = resolve("--background-card");
  const background = resolve("--terminal-background") || (card ? compositeOver(card, solid) : solid);
  const foreground = resolve("--terminal-foreground") || resolve("--text-primary") || "#e8e8ed";
  const accent = resolve("--accent") || "#4cc2f4";

  const theme: TerminalTheme = {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, 0.35),
  };

  const light = isLight(background);
  const fallback = (name: AnsiColorName, bright: boolean): string => {
    const semantic = SEMANTIC_ANSI[name];
    if (semantic) return resolve(semantic);
    const onLight = light ? LIGHT_BACKGROUND_ANSI[name] : undefined;
    return onLight ? resolve(onLight[bright ? 1 : 0]) : "";
  };

  for (const name of ANSI_COLOR_NAMES) {
    const normal = resolve(`--terminal-${name}`) || fallback(name, false);
    if (normal) theme[name] = normal;
    const bright = resolve(`--terminal-bright-${name}`) || fallback(name, true) || normal;
    if (bright) theme[`bright${name[0].toUpperCase()}${name.slice(1)}` as BrightAnsiColorName] = bright;
  }

  return theme;
}
