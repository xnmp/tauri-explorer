import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  MOCK_CORE,
  impactCandidates,
  selectChromium,
  selectCoverage,
  selectViewModes,
  selectViewModesCoverage,
} from "../scripts/e2e-affected.mjs";
import { mergeImpact } from "../scripts/impact-coverage.mjs";
import { selectFromImpact, type ChangedFile } from "../scripts/impact-select.mjs";

// The mock backend after its split into command families (#1372): its core
// (dispatcher, control surface, fixtures) reaches every spec, while a family
// module is placed by the test-impact map like any other src/ file.

const FAMILY = "src/lib/api/mock-git.ts";
const map = { hubs: [], clusters: [] };
const specs = [
  { rel: "e2e/scm.spec.ts", content: "import { test } from './fixtures'; test('scm')" },
  { rel: "e2e/graph.spec.ts", content: "import { test } from './fixtures'; test('graph')" },
  { rel: "e2e/quick-open.spec.ts", content: "import { test } from './fixtures'; test('quick-open')" },
];
const support = [{ rel: "e2e/fixtures.ts", content: "export const test = 1;" }];
const loaded = (id: string, spec: string, files: string[]) => ({ id, spec, title: [id], location: `${spec}:1`, loaded: files, exercised: files });
const impact = mergeImpact([
  loaded("t0", "e2e/scm.spec.ts", [FAMILY, "src/lib/api/mock-invoke.ts"]),
  loaded("t1", "e2e/graph.spec.ts", [FAMILY, "src/lib/api/mock-invoke.ts"]),
  loaded("t2", "e2e/quick-open.spec.ts", ["src/lib/api/mock-invoke.ts"]),
], [], { commit: "c0ffee", generatedAt: new Date().toISOString() });

const modified = (path: string): ChangedFile => ({ path, status: "modified", baseText: "export const a = 1;", headText: "export const a = 2;" });
const select = (changed: ChangedFile[]) => selectFromImpact({ impact, changed, ts, level: "file", exists: () => true });
const input = (changed: string[], files: ChangedFile[] = changed.map(modified)) =>
  ({ changed, map, specs, support, read: () => "let a;", impact, impactSelection: select(files) });

describe("mock backend selection (#1372)", () => {
  it("sends only non-core src/ files to the impact map", () => {
    expect(impactCandidates([FAMILY, "src/lib/api/mock-invoke.ts", "src/lib/api/mock-fixtures.ts", "src/lib/x.ts", "e2e/a.spec.ts"]))
      .toEqual([FAMILY, "src/lib/x.ts"]);
  });

  it.each([...MOCK_CORE])("runs everything for a mock core change (%s), with or without a map", (core) => {
    expect(selectCoverage(input([core], [])).mode).toBe("all");
    expect(selectChromium({ changed: [core], map, specs }).mode).toBe("all");
    expect(selectViewModesCoverage({ ...input([core], []), support }).mode).toBe("all");
  });

  it("runs everything for a family change without a map", () => {
    expect(selectChromium({ changed: [FAMILY], map, specs })).toMatchObject({ mode: "all" });
    expect(selectViewModes({ changed: [FAMILY], map, specs, support }).mode).toBe("all");
  });

  it("selects the specs the map reaches for a family change", () => {
    expect(selectCoverage(input([FAMILY]))).toEqual({
      mode: "selected",
      reason: "2 coverage-mapped spec(s) from 1 changed file(s)",
      items: ["e2e/graph.spec.ts", "e2e/scm.spec.ts"],
    });
  });

  it("does not escalate a family change for the view-mode tier", () => {
    expect(selectViewModesCoverage({ ...input([FAMILY]), support }).mode).not.toBe("all");
  });

  it("runs everything for a new family file the map has never seen", () => {
    const added: ChangedFile = { path: "src/lib/api/mock-new.ts", status: "added", baseText: null, headText: "export const a = 1;" };
    const result = selectCoverage(input([added.path], [added]));
    expect(result.mode).toBe("all");
    expect(result.reason).toContain("new file, not in the impact map: src/lib/api/mock-new.ts");
  });

  it("runs everything, never nothing, for a renamed family file", () => {
    // The selector diffs with --no-renames: a rename is a delete plus an add.
    const deleted: ChangedFile = { path: FAMILY, status: "deleted", baseText: "export const a = 1;", headText: null };
    const added: ChangedFile = { path: "src/lib/api/mock-git-moved.ts", status: "added", baseText: null, headText: "export const a = 1;" };
    const result = selectCoverage(input([FAMILY, added.path], [deleted, added]));
    expect(result.mode).toBe("all");
  });
});
