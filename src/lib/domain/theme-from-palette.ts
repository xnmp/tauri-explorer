/**
 * Theme generation from an extracted image palette (#203).
 * Pure functions: palette colors in, complete theme CSS out — everything the
 * theme engine's discovery scan needs (--theme-name, --background-solid,
 * --divider, --accent) plus the full variable set the UI consumes.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** OKLCH colour: perceptual lightness 0…1, chroma ≥ 0, hue in degrees. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/**
 * Contrast every generated text token must reach against its worst surface.
 * Above WCAG AA's 4.5:1 so hex rounding cannot drop a token below it (#791).
 */
export const TEXT_CONTRAST_TARGET = 4.6;

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG-ish relative luminance, 0 (black) … 1 (white). */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Saturation in [0,1] (HSL definition). */
export function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === min) return 0;
  const l = (max + min) / 2;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/** WCAG contrast ratio, 1 (identical) … 21 (black on white). Order-insensitive. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const toLinear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** Linear sRGB channels (unclamped) of an OKLCH colour. */
function oklchToLinear({ l: L, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * OKLCH → 8-bit sRGB. Out-of-gamut colours keep lightness and hue and lose
 * only as much chroma as the gamut requires.
 */
function oklchToRgb(color: Oklch): Rgb {
  const inGamut = (c: number) => oklchToLinear({ ...color, c }).every((v) => v >= -1e-6 && v <= 1 + 1e-6);
  let c = color.c;
  if (!inGamut(c)) {
    let lo = 0;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + c) / 2;
      if (inGamut(mid)) lo = mid; else c = mid;
    }
    c = lo;
  }
  const [r, g, b] = oklchToLinear({ ...color, c, l: Math.max(0, Math.min(1, color.l)) })
    .map((v) => Math.round(Math.max(0, Math.min(255, fromLinear(Math.max(0, Math.min(1, v)))))));
  return { r, g, b };
}

/** Worst (lowest) contrast of `text` across `surfaces`. */
function worstContrast(text: Rgb, surfaces: Rgb[]): number {
  return Math.min(...surfaces.map((s) => contrastRatio(text, s)));
}

/**
 * The colour closest to the surfaces in OKLCH lightness — hue and chroma kept
 * from `seed` — whose worst contrast reaches `target`. `lighter` says which
 * side of the surfaces the text lives on. The caller guarantees the extreme
 * (white / black) reaches the target, which is the fallback.
 */
function solveTextLightness(seed: Rgb, target: number, surfaces: Rgb[], lighter: boolean): Rgb {
  const { c, h } = rgbToOklch(seed);
  const at = (l: number) => oklchToRgb({ l, c, h });
  let pass = lighter ? 1 : 0;
  let fail = lighter ? 0 : 1;
  for (let i = 0; i < 30; i++) {
    const mid = (pass + fail) / 2;
    if (worstContrast(at(mid), surfaces) >= target) pass = mid; else fail = mid;
  }
  const solved = at(pass);
  if (worstContrast(solved, surfaces) >= target) return solved;
  return lighter ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
}

/** Source-over composite of `top` at `alpha` (8-bit, as emitted by rgba()). */
function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  const ch = (t: number, u: number) => Math.round(Math.round(t) * alpha + Math.round(u) * (1 - alpha));
  return { r: ch(top.r, under.r), g: ch(top.g, under.g), b: ch(top.b, under.b) };
}

/** Mix `a` toward `b` by t∈[0,1]. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/** Accent tint behind selected rows and active items (components use ≤ 20%). */
const SELECTED_ACCENT_ALPHA = 0.2;
/** Minimum worst-case ratio between secondary and tertiary text. */
const TIER_STEP = 1.2;
/** White/black text must reach this so three AA tiers fit (4.6 × 1.4). */
const MIN_HEADROOM = 6.5;
const SYSTEM_FILLS = {
  "system-critical": "#ef5350",
  "system-success": "#66bb6a",
  "system-caution": "#ffa726",
} as const;

const BLACK: Rgb = { r: 8, g: 9, b: 12 };
const WHITE: Rgb = { r: 248, g: 249, b: 252 };

function rgba({ r, g, b }: Rgb, a: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

/** A filesystem- and CSS-safe theme id from an arbitrary image name. */
export function themeIdFromName(imageName: string): string {
  const base = imageName.replace(/\.[^.]+$/, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `img-${base || "theme"}`;
}

export interface GeneratedTheme {
  id: string;
  name: string;
  css: string;
  /** True when the generated theme is dark (drives color-scheme). */
  dark: boolean;
}

/**
 * Build a complete theme from dominant colors (dominant first).
 * The most dominant color decides light/dark; the most saturated
 * sufficiently-contrasting color becomes the accent.
 */
export function buildTheme(hexColors: string[], id: string, name: string): GeneratedTheme | null {
  const colors = hexColors.map(hexToRgb).filter((c): c is Rgb => c !== null);
  if (colors.length === 0) return null;

  const dominant = colors[0];
  const dark = luminance(dominant) < 0.4;

  // Surface: dominant pulled toward the extreme so text always has room.
  let bg = dark ? mix(dominant, BLACK, 0.72) : mix(dominant, WHITE, 0.78);
  const bgLum = luminance(bg);

  // Accent: most saturated palette color that isn't the surface itself.
  const accent = [...colors]
    .sort((a, b) => saturation(b) - saturation(a))
    .find((c) => Math.abs(luminance(c) - bgLum) > 0.08) ?? mix(dominant, dark ? WHITE : BLACK, 0.5);
  // Keep the accent legible against the surface.
  const accentAdj = dark
    ? (luminance(accent) < 0.18 ? mix(accent, WHITE, 0.35) : accent)
    : (luminance(accent) > 0.6 ? mix(accent, BLACK, 0.35) : accent);

  // Every surface text is painted on, composited as the browser does: the
  // window, cards, the Miller column, hover fills (also on cards) and the
  // accent tint behind selected rows (#791).
  const toward = dark ? WHITE : BLACK;
  const extreme: Rgb = dark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const surfacesFor = (base: Rgb, ink: Rgb): Rgb[] => {
    const card = over(mix(base, toward, 0.09), 0.45, base);
    return [
      base,
      card,
      over(mix(base, toward, 0.05), 0.4, base),
      mix(base, toward, 0.03),
      over(ink, 0.055, base),
      over(ink, 0.055, card),
      over(accentAdj, SELECTED_ACCENT_ALPHA, base),
    ].map((c) => hexToRgb(rgbToHex(c))!);
  };
  const inkFor = (base: Rgb) => (dark ? mix(WHITE, base, 0.06) : mix(BLACK, base, 0.08));
  // Push the surface further toward the extreme until white/black text has
  // room for three AA text levels with visible steps between them.
  let surfaces = surfacesFor(bg, inkFor(bg));
  for (let i = 0; i < 24 && worstContrast(extreme, surfaces) < MIN_HEADROOM; i++) {
    bg = mix(bg, dark ? BLACK : WHITE, 0.2);
    surfaces = surfacesFor(bg, inkFor(bg));
  }
  const maxContrast = worstContrast(extreme, surfaces);

  // `ink` tints strokes and fills; the text tokens are solved for contrast,
  // starting from the hue/chroma of the old fixed interpolations.
  const ink = inkFor(bg);
  const solve = (seed: Rgb, target: number) => solveTextLightness(seed, target, surfaces, dark);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const textFaint = solve(
    mix(ink, bg, 0.68),
    clamp(worstContrast(mix(ink, bg, 0.68), surfaces), TEXT_CONTRAST_TARGET, maxContrast / 1.4),
  );
  const faintRatio = worstContrast(textFaint, surfaces);
  const textDim = solve(
    mix(ink, bg, 0.42),
    Math.min(Math.max(worstContrast(mix(ink, bg, 0.42), surfaces), TIER_STEP * faintRatio), maxContrast / 1.1),
  );
  const text = solve(
    ink,
    Math.min(Math.max(worstContrast(ink, surfaces), 1.05 * worstContrast(textDim, surfaces)), maxContrast),
  );

  // Fills too light/dark to read as text get a contrast-solved `-text` twin.
  const fillText = (token: string, fill: Rgb) =>
    worstContrast(fill, surfaces) >= TEXT_CONTRAST_TARGET
      ? ""
      : `\n  --${token}-text: ${rgbToHex(solve(fill, TEXT_CONTRAST_TARGET))};`;
  const statusText = Object.entries(SYSTEM_FILLS)
    .map(([token, fill]) => fillText(token, hexToRgb(fill)!))
    .join("");

  const raise = (t: number) => rgbToHex(mix(bg, dark ? WHITE : BLACK, t));
  const onAccent = luminance(accentAdj) > 0.45 ? rgbToHex(BLACK) : rgbToHex(WHITE);

  const css = `/* Generated by Theme from Image — source: ${name} */
[data-theme="${id}"] {
  color-scheme: ${dark ? "dark" : "light"};

  --theme-name: "${name}";
  --theme-description: "Generated from an image";

  --accent: ${rgbToHex(accentAdj)};
  --accent-light: ${rgbToHex(mix(accentAdj, WHITE, 0.25))};
  --accent-dark: ${rgbToHex(mix(accentAdj, BLACK, 0.25))};${fillText("accent", accentAdj)}
  --text-primary: ${rgbToHex(text)};
  --text-secondary: ${rgbToHex(textDim)};
  --text-tertiary: ${rgbToHex(textFaint)};
  --text-on-accent: ${onAccent};

  --background-solid: ${rgbToHex(bg)};
  --background-mica: ${rgba(bg, 0.86)};
  --background-acrylic: ${rgba(mix(bg, dark ? WHITE : BLACK, 0.04), 0.8)};
  --background-card: ${rgba(mix(bg, dark ? WHITE : BLACK, 0.09), 0.45)};
  --background-card-secondary: ${rgba(mix(bg, dark ? WHITE : BLACK, 0.05), 0.4)};
  --miller-bg: ${raise(0.03)};
  --content-bg: ${rgba(bg, 0.35)};

  --surface-stroke: ${rgba(ink, 0.09)};
  --surface-stroke-flyout: ${rgba(ink, 0.14)};
  --divider: ${rgba(ink, 0.1)};

  --control-fill: ${rgba(ink, 0.055)};
  --control-fill-secondary: ${rgba(ink, 0.085)};
  --control-fill-tertiary: ${rgba(ink, 0.03)};
  --control-fill-disabled: ${rgba(ink, 0.02)};
  --subtle-fill: transparent;
  --subtle-fill-secondary: ${rgba(ink, 0.055)};
  --subtle-fill-tertiary: ${rgba(ink, 0.03)};
  --control-stroke: ${rgba(ink, 0.14)};
  --control-stroke-secondary: ${rgba(ink, 0.08)};

  --address-bar-bg: ${rgba(mix(bg, dark ? WHITE : BLACK, 0.05), 0.6)};
  --address-bar-stroke: ${rgba(ink, 0.1)};
  --address-bar-highlight: ${rgba(accentAdj, 0.4)};
  --address-bar-bg-hover: ${rgba(mix(bg, dark ? WHITE : BLACK, 0.08), 0.7)};
  --address-bar-stroke-hover: ${rgba(ink, 0.16)};

  --focus-stroke-outer: ${rgbToHex(accentAdj)};
  --focus-stroke-inner: ${rgba(bg, 1)};

  --system-critical: ${SYSTEM_FILLS["system-critical"]};
  --system-success: ${SYSTEM_FILLS["system-success"]};
  --system-caution: ${SYSTEM_FILLS["system-caution"]};${statusText}

  --shadow-flyout: 0 8px 16px ${rgba(BLACK, dark ? 0.5 : 0.14)};
  --shadow-dialog: 0 32px 64px ${rgba(BLACK, dark ? 0.6 : 0.18)};
  --shadow-tooltip: 0 4px 8px ${rgba(BLACK, dark ? 0.4 : 0.12)};
  --shadow-card: 0 2px 4px ${rgba(BLACK, dark ? 0.26 : 0.06)};
  --shadow-subtle: 0 1px 2px ${rgba(BLACK, dark ? 0.2 : 0.05)};
  --mica-overlay: ${rgba(bg, 0.5)};

  --sidebar-opacity: 1;
  --toolbar-opacity: 1;
  --content-opacity: 1;
  --titlebar-opacity: 1;
  --statusbar-opacity: 1;
}
`;
  return { id, name, css, dark };
}
