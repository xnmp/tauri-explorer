import { describe, expect, it } from "vitest";
import {
  e2eImporters,
  selectCoverage,
  selectViewModesCoverage,
  selectWebkitCoverage,
} from "../scripts/e2e-affected.mjs";

// The PR tiers with a test-impact map (#1368). impact-select.mjs decides
// what src/ changes reach (tests/impact-select.test.ts); these tests pin how
// each tier combines that with the selector's other rules.

const map = { hubs: ["routes/+page.svelte"], clusters: [] };
const specs = [
  { rel: "e2e/quick-open.spec.ts", content: "import { test } from './fixtures'; import { helper } from './helpers'; test('quick-open')" },
  { rel: "e2e/tiles.spec.ts", content: "import { test } from './fixtures'; import { view_modes } from './helpers'; for (const m of view_modes) test(m)" },
  { rel: "e2e/engine.spec.ts", content: "import { test } from './fixtures'; test.skip(browsername === 'webkit')" },
  { rel: "e2e/pixels.spec.ts", content: "import { test } from './fixtures'; import { decodepng } from './png-pixels'; test('px')" },
  { rel: "e2e/new.spec.ts", content: "import { test } from './fixtures'; test('not in the map yet')" },
  { rel: "e2e/cloud.spec.ts", content: "import { test } from './fixtures'; readfilesync('tests/fixtures/cloud.json')" },
  // Exists on disk, so the "changed spec selects itself" rule can see it.
  { rel: "e2e/about-command.spec.ts", content: "import { test } from './fixtures'; test('about')" },
];
const support = [
  { rel: "e2e/fixtures.ts", content: "import { collectimpactcoverage } from './impact-coverage';" },
  { rel: "e2e/impact-coverage.ts", content: "export const x = 1;" },
  { rel: "e2e/helpers.ts", content: "export const view_modes = [];" },
  { rel: "e2e/png-pixels.ts", content: "export function decodepng() {}" },
];
const impact = {
  version: 1, commit: "c0ffee", generatedAt: new Date().toISOString(),
  specs: ["e2e/about-command.spec.ts", "e2e/cloud.spec.ts", "e2e/engine.spec.ts", "e2e/pixels.spec.ts", "e2e/quick-open.spec.ts", "e2e/tiles.spec.ts"],
  tests: [], files: { "src/lib/x.ts": ["e2e/quick-open.spec.ts"] }, exercised: {}, assets: {}, lines: {}, sets: [],
};
const reached = (specList: string[], extra: Partial<{ all: string[], zeroCoverage: string[] }> = {}) => ({
  all: [], specs: new Set(specList), tests: new Set<number>(), zeroCoverage: [], fileLevel: [], hunkLevel: [], ...extra,
});
const input = (changed: string[], impactSelection = reached([]), read: (side: "base" | "head", p: string) => string | null = () => "let a;") =>
  ({ changed, map, specs, support, read, impact, impactSelection });

describe("selectCoverage (Chromium with an impact map)", () => {
  it("selects what the map reaches plus specs the map has no coverage for", () => {
    expect(selectCoverage(input(["src/lib/x.ts"], reached(["e2e/quick-open.spec.ts"])))).toEqual({
      mode: "selected",
      reason: "2 coverage-mapped spec(s) from 1 changed file(s)",
      items: ["e2e/new.spec.ts", "e2e/quick-open.spec.ts"],
    });
  });

  it("adds no unmapped specs when no src/ file changed", () => {
    expect(selectCoverage(input(["e2e/about-command.spec.ts", "src-tauri/src/lib.rs"]))).toMatchObject({ mode: "selected", items: ["e2e/about-command.spec.ts"] });
    expect(selectCoverage(input(["docs/x.md"])).mode).toBe("none");
  });

  it("selects nothing for a src/ change the map proves inert, except uncovered specs", () => {
    expect(selectCoverage(input(["src/lib/types.ts"]))).toMatchObject({ items: ["e2e/new.spec.ts"] });
  });

  it("keeps the selector's escalations", () => {
    for (const file of ["src/lib/api/mock-invoke.ts", "package.json", "bun.lock", "playwright.config.ts",
      "scripts/e2e-affected.mjs", ".github/workflows/ci.yml", "weird-top-level.txt"]) {
      expect(selectCoverage(input([file])).mode, file).toBe("all");
    }
  });

  it("escalates whatever impact selection could not place", () => {
    const result = selectCoverage(input(["src/lib/new.ts"], reached([], { all: ["new file, not in the impact map: src/lib/new.ts"] })));
    expect(result).toMatchObject({ mode: "all", reason: "new file, not in the impact map: src/lib/new.ts" });
  });

  it("selects the specs importing a changed e2e support module", () => {
    expect(selectCoverage(input(["e2e/png-pixels.ts"]))).toMatchObject({ mode: "selected", items: ["e2e/pixels.spec.ts"] });
    // fixtures.ts imports impact-coverage.ts, and every spec imports fixtures.
    expect(selectCoverage(input(["e2e/impact-coverage.ts"])).items).toHaveLength(specs.length);
  });

  it("still selects a spec that names a changed fixture path", () => {
    expect(selectCoverage(input(["tests/fixtures/cloud.json"]))).toMatchObject({ items: ["e2e/cloud.spec.ts"] });
  });
});

describe("e2eImporters", () => {
  it("follows support modules transitively", () => {
    expect(e2eImporters(["e2e/impact-coverage.ts"], specs, support)).toHaveLength(specs.length);
    expect(e2eImporters(["e2e/png-pixels.ts"], specs, support)).toEqual(["e2e/pixels.spec.ts"]);
  });
  it("refuses files it cannot follow", () => {
    expect(e2eImporters(["e2e/data/fixture.json"], specs, support)).toBeNull();
  });
});

describe("selectWebkitCoverage", () => {
  it("adds the curated engine-specific specs", () => {
    expect(selectWebkitCoverage(input(["src/lib/x.ts"], reached(["e2e/quick-open.spec.ts"])))).toMatchObject({
      mode: "selected", items: ["e2e/engine.spec.ts", "e2e/new.spec.ts", "e2e/quick-open.spec.ts"],
    });
  });

  it("runs every WebKit spec for a sensitive path, engine detection, or code Chromium never ran", () => {
    expect(selectWebkitCoverage(input(["src/lib/domain/zoom.ts"], reached(["e2e/quick-open.spec.ts"]))).mode).toBe("all");
    expect(selectWebkitCoverage(input(["src/lib/x.ts"], reached(["e2e/quick-open.spec.ts"]), () => "if (isChromiumEngine) a();")).reason)
      .toContain("engine detection");
    expect(selectWebkitCoverage(input(["src/lib/x.ts"], reached(["e2e/quick-open.spec.ts"], { zeroCoverage: ["src/lib/x.ts:12"] }))).reason)
      .toContain("no Chromium test executed");
  });

  it("selects none when nothing reaches the browser", () => {
    expect(selectWebkitCoverage(input(["docs/x.md"])).mode).toBe("none");
  });
});

describe("selectViewModesCoverage", () => {
  it("keeps only the view-mode specs of the coverage selection", () => {
    expect(selectViewModesCoverage(input(["src/lib/x.ts"], reached(["e2e/quick-open.spec.ts", "e2e/tiles.spec.ts"])))).toMatchObject({
      mode: "selected", items: ["e2e/tiles.spec.ts"],
    });
    expect(selectViewModesCoverage(input(["src/lib/x.ts"], reached(["e2e/quick-open.spec.ts"]))).mode).toBe("none");
  });

  it("runs every view-mode spec for global presentation changes", () => {
    expect(selectViewModesCoverage(input(["src/lib/themes/nord.css"])).mode).toBe("all");
  });

  it("falls back to the component rule when coverage cannot place the change", () => {
    const result = selectViewModesCoverage(input(["src/lib/domain/new.ts"], reached([], { all: ["new file"] })));
    expect(result.mode).toBe("none");
  });
});
