import { describe, expect, it } from "vitest";
import {
  TRANSLUCENCY_OPACITY_DEFAULT,
  TRANSLUCENCY_OPACITY_MAX,
  TRANSLUCENCY_OPACITY_MIN,
  clampTranslucencyOpacity,
  darkCoverage,
  darkIslandAlpha,
  lightCoverage,
  materialOpaque,
  opacityForIslandAlpha,
  stripShadeShare,
  surfaceCoverage,
  vibrancyCoverageVariables,
  windowCoverage,
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
      "--material-window-coverage": "0.15",
      "--material-window-coverage-dark": "0.55",
      "--material-surface-coverage": "0.82",
      "--island-strip-shade": "0.35",
      "--island-strip-shade-dark": "0.5",
      "--material-opaque": "0",
    });
  });
});

describe("surface coverage of flat layouts (#1789)", () => {
  it("is opaque at the solid end and keeps the theme dominant at the see-through end", () => {
    expect(surfaceCoverage(TRANSLUCENCY_OPACITY_MAX)).toBe(1);
    expect(surfaceCoverage(TRANSLUCENCY_OPACITY_DEFAULT)).toBe(0.82);
  });

  it("never hides less than the panes did before the uniform surfaces (#1789 review)", () => {
    // Panes before #1789: dark 0.68 / light 0.733 at 20%, dark 0.82 / light
    // 0.761 at 55%, dark rising linearly to 1.
    const darkPaneBefore = (p: number) => (p <= 55 ? 0.68 + (0.14 * (p - 20)) / 35 : 0.82 + (0.18 * (p - 55)) / 45);
    for (const p of percents) {
      expect(surfaceCoverage(p), `@${p}`).toBeGreaterThanOrEqual(darkPaneBefore(p) - 1e-9);
    }
    expect(surfaceCoverage(TRANSLUCENCY_OPACITY_MIN)).toBeGreaterThanOrEqual(0.733);
  });

  it("rises strictly with the slider, so every step is visible", () => {
    for (let i = 1; i < percents.length; i++) {
      expect(surfaceCoverage(percents[i])).toBeGreaterThan(surfaceCoverage(percents[i - 1]));
    }
  });

  it("clamps out-of-range and malformed input", () => {
    expect(surfaceCoverage(-50)).toBe(surfaceCoverage(TRANSLUCENCY_OPACITY_MIN));
    expect(surfaceCoverage(1e9)).toBe(1);
    expect(surfaceCoverage(Number.NaN)).toBe(surfaceCoverage(TRANSLUCENCY_OPACITY_DEFAULT));
    expect(surfaceCoverage(null)).toBe(surfaceCoverage(TRANSLUCENCY_OPACITY_DEFAULT));
    expect(surfaceCoverage("90")).toBe(surfaceCoverage(TRANSLUCENCY_OPACITY_DEFAULT));
  });
});

describe("window coverage (#1757)", () => {
  it("moves the tint of layouts without islands with the slider, opaque at the top", () => {
    expect(windowCoverage(20).dark).toBeLessThan(windowCoverage(55).dark);
    expect(windowCoverage(55).dark).toBeLessThan(windowCoverage(100).dark);
    expect(windowCoverage(100)).toEqual({ light: 0.4, dark: 1 });
    expect(windowCoverage(Number.NaN)).toEqual(windowCoverage(TRANSLUCENCY_OPACITY_DEFAULT));
  });
});

describe("opacityForIslandAlpha (#1757 migration)", () => {
  it("finds the percent whose dark island alpha matches a Windows backdrop's", () => {
    for (const alpha of [0.2, 0.35, 0.5, 0.65, 0.85, 1]) {
      expect(Math.abs(darkIslandAlpha(opacityForIslandAlpha(alpha)) - alpha)).toBeLessThan(0.02);
    }
    expect(opacityForIslandAlpha(darkIslandAlpha(TRANSLUCENCY_OPACITY_DEFAULT))).toBe(TRANSLUCENCY_OPACITY_DEFAULT);
  });

  it("is monotonic and stays in the slider's range", () => {
    let previous = 0;
    for (let alpha = 0; alpha <= 1; alpha += 0.05) {
      const p = opacityForIslandAlpha(alpha);
      expect(p).toBeGreaterThanOrEqual(previous);
      expect(p).toBeGreaterThanOrEqual(TRANSLUCENCY_OPACITY_MIN);
      expect(p).toBeLessThanOrEqual(TRANSLUCENCY_OPACITY_MAX);
      previous = p;
    }
  });

  it("clamps out-of-range alphas and falls back to the default for non-numbers", () => {
    expect(opacityForIslandAlpha(-3)).toBe(TRANSLUCENCY_OPACITY_MIN);
    expect(opacityForIslandAlpha(7)).toBe(TRANSLUCENCY_OPACITY_MAX);
    expect(opacityForIslandAlpha("0.5")).toBe(TRANSLUCENCY_OPACITY_DEFAULT);
    expect(opacityForIslandAlpha(Number.POSITIVE_INFINITY)).toBe(TRANSLUCENCY_OPACITY_DEFAULT);
  });
});

describe("coverage mapping", () => {
  it("makes the dark island coverage track the slider and keeps the dark ratios", () => {
    expect(darkCoverage(80).island).toBeGreaterThan(darkCoverage(60).island);
    for (const p of [20, 35, 50, 81, 100]) {
      const d = darkCoverage(p);
      expect(d.structural / d.island).toBeCloseTo(0.48 / 0.545, 4);
      expect(d.body / d.island).toBeCloseTo(0.3 / 0.545, 4);
    }
  });

  it("keeps the curve v0.28/v0.29 shipped, so a saved value keeps its look (#1789 review)", () => {
    // Values the shipped curve gave; 81 is where a 65% Windows Backdrop
    // Opacity migrated to.
    expect(darkCoverage(20)).toEqual({ island: 0.2, structural: 0.176147, body: 0.110092 });
    expect(darkCoverage(81)).toEqual({ island: 0.807889, structural: 0.711535, body: 0.444709 });
    expect(darkCoverage(99)).toEqual({ island: 0.989889, structural: 0.871829, body: 0.544893 });
    expect(lightCoverage(81)).toEqual({ island: 0.992822, structural: 0.899511, body: 0.222222 });
    expect(lightCoverage(100)).toEqual({ island: 1, structural: 1, body: 0.275 });
    expect(darkIslandAlpha(81)).toBeCloseTo(0.654, 3);
  });

  it("makes only the solid end opaque (#1789)", () => {
    expect(materialOpaque(TRANSLUCENCY_OPACITY_MAX)).toBe(1);
    expect(materialOpaque(1e9)).toBe(1);
    for (const p of [TRANSLUCENCY_OPACITY_MIN, TRANSLUCENCY_OPACITY_DEFAULT, 99, 99.9]) expect(materialOpaque(p)).toBe(0);
    for (const bad of [NaN, null, "100", undefined]) expect(materialOpaque(bad)).toBe(0);
    expect(darkCoverage(TRANSLUCENCY_OPACITY_MAX).island).toBe(1);
    expect(lightCoverage(TRANSLUCENCY_OPACITY_MAX).island).toBe(1);
    // The strip: the translucent strip's share below 100%, the opaque strip's at 100%.
    expect(stripShadeShare(TRANSLUCENCY_OPACITY_MAX)).toEqual({ light: 0.62, dark: 0.9 });
    for (const p of [TRANSLUCENCY_OPACITY_MIN, TRANSLUCENCY_OPACITY_DEFAULT, 99]) {
      expect(stripShadeShare(p)).toEqual({ light: 0.35, dark: 0.5 });
    }
    expect(vibrancyCoverageVariables(TRANSLUCENCY_OPACITY_MAX)["--material-opaque"]).toBe("1");
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
