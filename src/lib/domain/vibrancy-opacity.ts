/**
 * Translucency Opacity (#1735): maps the one slider (macOS + Native Blur) to
 * the six coverage variables of the Floating Islands material contract
 * (`--island-*coverage*` in `layouts/floating-islands.css`). A coverage is the
 * share of the native material a surface hides in total.
 *
 * The slider percent is the content islands' coverage in dark themes. The
 * sidebar and window body follow at their dark-default ratios to the island
 * (0.48/0.545 and 0.3/0.545).
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

/** The six inline custom properties for a slider percent. */
export function vibrancyCoverageVariables(percent: unknown): VibrancyCoverageVariables {
  const l = lightCoverage(percent);
  const d = darkCoverage(percent);
  return {
    "--island-coverage": String(l.island),
    "--island-structural-coverage": String(l.structural),
    "--island-body-coverage": String(l.body),
    "--island-coverage-dark": String(d.island),
    "--island-structural-coverage-dark": String(d.structural),
    "--island-body-coverage-dark": String(d.body),
  };
}
