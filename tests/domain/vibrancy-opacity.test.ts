import { describe, expect, it } from "vitest";
import {
  TRANSLUCENCY_OPACITY_DEFAULT,
  TRANSLUCENCY_OPACITY_MAX,
  TRANSLUCENCY_OPACITY_MIN,
  clampTranslucencyOpacity,
  darkCoverage,
  lightCoverage,
  vibrancyCoverageVariables,
} from "$lib/domain/vibrancy-opacity";

const percents = Array.from(
  { length: TRANSLUCENCY_OPACITY_MAX - TRANSLUCENCY_OPACITY_MIN + 1 },
  (_, i) => TRANSLUCENCY_OPACITY_MIN + i,
);

describe("vibrancyCoverageVariables defaults", () => {
  it("reproduces the previous fixed defaults at the default percent", () => {
    expect(vibrancyCoverageVariables(TRANSLUCENCY_OPACITY_DEFAULT)).toEqual({
      "--island-coverage": "0.983",
      "--island-structural-coverage": "0.762",
      "--island-body-coverage": "0.15",
      "--island-coverage-dark": "0.545",
      "--island-structural-coverage-dark": "0.48",
      "--island-body-coverage-dark": "0.3",
    });
  });
});

describe("coverage mapping", () => {
  it("makes the dark island coverage track the slider and keeps the dark ratios", () => {
    const d = darkCoverage(80);
    expect(d.island).toBeGreaterThan(darkCoverage(60).island);
    expect(d.structural / d.island).toBeCloseTo(0.48 / 0.545, 4);
    expect(d.body / d.island).toBeCloseTo(0.3 / 0.545, 4);
  });

  it("is monotonic non-decreasing in the slider for every output", () => {
    for (const fn of [lightCoverage, darkCoverage]) {
      for (const key of ["island", "structural", "body"] as const) {
        for (let i = 1; i < percents.length; i++) {
          expect(fn(percents[i])[key], `${fn.name}.${key}@${percents[i]}`).toBeGreaterThanOrEqual(fn(percents[i - 1])[key]);
        }
      }
    }
  });

  it("keeps every coverage in [0, 1] and body below 1 across the range", () => {
    for (const p of percents) {
      for (const c of [lightCoverage(p), darkCoverage(p)]) {
        for (const v of [c.island, c.structural, c.body]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(c.body).toBeLessThan(1);
      }
    }
  });

  it("derives a valid island alpha (0..1, finite) at every percent", () => {
    for (const p of percents) {
      for (const c of [lightCoverage(p), darkCoverage(p)]) {
        for (const total of [c.island, c.structural]) {
          const alpha = 1 - (1 - total) / (1 - c.body);
          expect(Number.isFinite(alpha)).toBe(true);
          expect(alpha).toBeGreaterThanOrEqual(0);
          expect(alpha).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("makes light surfaces visibly more transparent at the minimum than at the default", () => {
    expect(lightCoverage(TRANSLUCENCY_OPACITY_MIN).island).toBeLessThan(0.9);
    expect(lightCoverage(TRANSLUCENCY_OPACITY_MIN).structural).toBeLessThan(0.5);
    expect(lightCoverage(TRANSLUCENCY_OPACITY_MAX).island).toBe(1);
  });
});

describe("input sanitising", () => {
  it("clamps out-of-range input to the slider range", () => {
    expect(clampTranslucencyOpacity(-5)).toBe(TRANSLUCENCY_OPACITY_MIN);
    expect(clampTranslucencyOpacity(0)).toBe(TRANSLUCENCY_OPACITY_MIN);
    expect(clampTranslucencyOpacity(1e9)).toBe(TRANSLUCENCY_OPACITY_MAX);
    expect(clampTranslucencyOpacity(Infinity)).toBe(TRANSLUCENCY_OPACITY_DEFAULT);
    expect(darkCoverage(1e9)).toEqual(darkCoverage(TRANSLUCENCY_OPACITY_MAX));
    expect(lightCoverage(-1e9)).toEqual(lightCoverage(TRANSLUCENCY_OPACITY_MIN));
  });

  it("treats malformed input as the default", () => {
    for (const bad of [NaN, undefined, null, "70", {}, []]) {
      expect(vibrancyCoverageVariables(bad)).toEqual(vibrancyCoverageVariables(TRANSLUCENCY_OPACITY_DEFAULT));
    }
  });

  it("keeps the body below 1 at the extremes", () => {
    expect(darkCoverage(TRANSLUCENCY_OPACITY_MAX).body).toBeLessThan(1);
    expect(lightCoverage(TRANSLUCENCY_OPACITY_MAX).body).toBeLessThan(1);
    expect(lightCoverage(TRANSLUCENCY_OPACITY_MIN).body).toBeGreaterThan(0);
  });
});
