/**
 * Translucency Opacity (#1735, cross-platform since #1757): maps the one
 * slider to the coverage variables of the window material contract: the six
 * Floating Islands ones (`--island-*coverage*` in `layouts/floating-islands.css`)
 * plus its strip shade share, the surface coverage of the flat layouts
 * (`--material-surface-coverage`, #1789) and the window tint of other layouts
 * (`--material-window-coverage*`, `routes/+page.svelte`). A coverage is the
 * share of the native material a surface hides in total. Lower is more
 * see-through.
 *
 * The slider percent is the content islands' coverage in dark themes. The
 * sidebar and window body follow at their dark-default ratios to the island
 * (0.48/0.545 and 0.3/0.545).
 *
 * Below 100% the islands' curve is the one v0.28/v0.29 shipped, so a value a
 * user saved keeps its look (#1789). 100% is the opaque window, as with
 * Translucency off: `--material-opaque` is 1 there and 0 below, and the
 * stylesheets make every surface solid on it (a theme's own fixed tint
 * included, which no coverage reaches).
 *
 * Light themes: scaling light transparency (1 - coverage) would barely move
 * the 98.3% light island (0.017 transparency), so the slider would look dead.
 * Instead each surface is piecewise-linear through three anchors: the range
 * minimum, the default (exactly today's values) and the maximum. Light surfaces
 * thus stay far more opaque than dark ones at the same percent (text on light
 * panels needs it) but visibly move across the whole range. Low ends keep every
 * surface above the body's coverage so the derived island alpha
 * `1 - (1 - c) / (1 - body)` is never negative.
 *
 * Invariants (tested): the default percent reproduces the previous fixed
 * defaults exactly, every output is monotonic in the percent and within [0, 1],
 * and body coverage stays below 1 so the alpha formula never divides by zero.
 */

export const TRANSLUCENCY_OPACITY_MIN = 20;
export const TRANSLUCENCY_OPACITY_MAX = 100;
export const TRANSLUCENCY_OPACITY_DEFAULT = 55;

export interface VibrancyCoverage {
  readonly island: number;
  readonly structural: number;
  readonly body: number;
}

export interface VibrancyCoverageVariables {
  readonly "--island-coverage": string;
  readonly "--island-structural-coverage": string;
  readonly "--island-body-coverage": string;
  readonly "--island-coverage-dark": string;
  readonly "--island-structural-coverage-dark": string;
  readonly "--island-body-coverage-dark": string;
  readonly "--material-window-coverage": string;
  readonly "--material-window-coverage-dark": string;
  readonly "--material-surface-coverage": string;
  readonly "--island-strip-shade": string;
  readonly "--island-strip-shade-dark": string;
  readonly "--material-opaque": string;
}

/** Coverage at (range minimum, default, range maximum). */
type Anchors = readonly [number, number, number];

const LIGHT: Record<keyof VibrancyCoverage, Anchors> = {
  island: [0.8, 0.983, 1],
  structural: [0.45, 0.762, 1],
  body: [0.05, 0.15, 0.275],
};

// Dark island = slider value (default 0.545 is 55% rounded); the others keep
// their default ratios to it.
const DARK_ISLAND: Anchors = [0.2, 0.545, 1];
const DARK_STRUCTURAL_RATIO = 0.48 / 0.545;
const DARK_BODY_RATIO = 0.3 / 0.545;

// Share of the strip shade colour Floating Islands paints over the window
// body: the translucent strip's below 100%, the opaque strip's at 100%.
const STRIP_TRANSLUCENT = { light: 0.35, dark: 0.5 } as const;
const STRIP_OPAQUE = { light: 0.62, dark: 0.9 } as const;

// The window tint of layouts without islands (default 15% light and 55% dark,
// the values it had before the slider reached it).
const WINDOW_LIGHT: Anchors = [0.05, 0.15, 0.4];
const WINDOW_DARK: Anchors = [0.2, 0.55, 1];

// Flat layouts (Default, Compact) fade the opaque window uniformly (#1789):
// every surface hides this share of the material, in light and dark themes
// alike. Before, each surface hid its own share; the panes, the largest,
// hid 0.68 (dark) and 0.73 (light) at 20%, 0.82 and 0.76 at 55%, and dark
// rose linearly to 1. The uniform share never hides less than the panes did
// at the see-through end, keeps the dark default and its rise to the opaque
// window.
const SURFACE: Anchors = [0.74, 0.82, 1];

/** Non-finite or non-numeric input falls back to the default; the rest clamps. */
export function clampTranslucencyOpacity(percent: unknown): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return TRANSLUCENCY_OPACITY_DEFAULT;
  return Math.min(TRANSLUCENCY_OPACITY_MAX, Math.max(TRANSLUCENCY_OPACITY_MIN, percent));
}

function through([lo, mid, hi]: Anchors, percent: number): number {
  const { MIN, MAX, DEFAULT } = {
    MIN: TRANSLUCENCY_OPACITY_MIN,
    MAX: TRANSLUCENCY_OPACITY_MAX,
    DEFAULT: TRANSLUCENCY_OPACITY_DEFAULT,
  };
  return percent <= DEFAULT
    ? lo + ((mid - lo) * (percent - MIN)) / (DEFAULT - MIN)
    : mid + ((hi - mid) * (percent - DEFAULT)) / (MAX - DEFAULT);
}

/** Round away float noise so the default reproduces literal CSS defaults. */
const tidy = (n: number): number => Math.min(1, Math.max(0, Math.round(n * 1e6) / 1e6));

export function lightCoverage(percent: unknown): VibrancyCoverage {
  const p = clampTranslucencyOpacity(percent);
  return {
    island: tidy(through(LIGHT.island, p)),
    structural: tidy(through(LIGHT.structural, p)),
    body: tidy(through(LIGHT.body, p)),
  };
}

export function darkCoverage(percent: unknown): VibrancyCoverage {
  const island = through(DARK_ISLAND, clampTranslucencyOpacity(percent));
  return {
    island: tidy(island),
    structural: tidy(island * DARK_STRUCTURAL_RATIO),
    body: tidy(island * DARK_BODY_RATIO),
  };
}

/** 1 at the slider's solid end (the opaque window), 0 below it. */
export function materialOpaque(percent: unknown): 0 | 1 {
  return clampTranslucencyOpacity(percent) >= TRANSLUCENCY_OPACITY_MAX ? 1 : 0;
}

/** Share of the strip shade colour Floating Islands' strip paints, light and dark. */
export function stripShadeShare(percent: unknown): { readonly light: number; readonly dark: number } {
  return materialOpaque(percent) ? STRIP_OPAQUE : STRIP_TRANSLUCENT;
}

/** Coverage of the window tint for layouts without islands, light and dark. */
export function windowCoverage(percent: unknown): { readonly light: number; readonly dark: number } {
  const p = clampTranslucencyOpacity(percent);
  return { light: tidy(through(WINDOW_LIGHT, p)), dark: tidy(through(WINDOW_DARK, p)) };
}

/** Share of the material every surface of a flat layout hides (#1789). */
export function surfaceCoverage(percent: unknown): number {
  return tidy(through(SURFACE, clampTranslucencyOpacity(percent)));
}

/** Alpha a dark content island paints over the window body: the share of the
 *  material it hides beyond what the body already hides. */
export function darkIslandAlpha(percent: unknown): number {
  const { island, body } = darkCoverage(percent);
  return 1 - (1 - island) / (1 - body);
}

/**
 * The slider percent whose dark island alpha is closest to `alpha` (0 to 1).
 * Settings from before #1757 gave Windows islands a fill alpha directly
 * ("Backdrop Opacity"); this keeps that look when they migrate. Out-of-range
 * or non-numeric input clamps to the slider's range or falls back to its
 * default.
 */
export function opacityForIslandAlpha(alpha: unknown): number {
  if (typeof alpha !== "number" || !Number.isFinite(alpha)) return TRANSLUCENCY_OPACITY_DEFAULT;
  let best = TRANSLUCENCY_OPACITY_MIN;
  for (let p = TRANSLUCENCY_OPACITY_MIN; p <= TRANSLUCENCY_OPACITY_MAX; p++) {
    if (Math.abs(darkIslandAlpha(p) - alpha) < Math.abs(darkIslandAlpha(best) - alpha)) best = p;
  }
  return best;
}

/** The inline custom properties for a slider percent. */
export function vibrancyCoverageVariables(percent: unknown): VibrancyCoverageVariables {
  const l = lightCoverage(percent);
  const d = darkCoverage(percent);
  const w = windowCoverage(percent);
  return {
    "--island-coverage": String(l.island),
    "--island-structural-coverage": String(l.structural),
    "--island-body-coverage": String(l.body),
    "--island-coverage-dark": String(d.island),
    "--island-structural-coverage-dark": String(d.structural),
    "--island-body-coverage-dark": String(d.body),
    "--material-window-coverage": String(w.light),
    "--material-window-coverage-dark": String(w.dark),
    "--material-surface-coverage": String(surfaceCoverage(percent)),
    "--island-strip-shade": String(stripShadeShare(percent).light),
    "--island-strip-shade-dark": String(stripShadeShare(percent).dark),
    "--material-opaque": String(materialOpaque(percent)),
  };
}
