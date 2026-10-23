import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mergeImpact } from "../scripts/impact-coverage.mjs";
import { invertHunks, lineTranslator, selectFromImpact, type ChangedFile } from "../scripts/impact-select.mjs";

// src/lib/x.ts at the map's commit. Tests: t0 (a) calls alpha(0), t1 (b)
// calls alpha(1), t2 (c) only loads the module. Nobody calls beta.
const X = [
  'import { helper } from "./y";', //  1
  "// comment", //                       2
  "export interface Shape { a: number }", // 3
  "export function alpha(n: number) {", // 4
  "  if (n > 0) {", //                   5
  "    return helper(n);", //            6
  "  }", //                              7
  "  return 0;", //                      8
  "}", //                                9
  "export function beta() {", //        10
  "  return 2;", //                     11
  "}", //                               12
  "export const K = 1;", //             13
].join("\n");
const BLOB = "blob-x";
const record = (id: string, spec: string, lines: Array<[number, number]>, loaded = ["src/lib/x.ts", "src/lib/y.ts"]) =>
  ({ id, spec, title: [id], location: `${spec}:1`, loaded, exercised: loaded, lines: { "src/lib/x.ts": lines } });
const impact = mergeImpact([
  record("t0", "e2e/a.spec.ts", [[1, 1], [4, 5], [8, 8], [10, 10], [13, 13]]),
  record("t1", "e2e/b.spec.ts", [[1, 1], [4, 6], [10, 10], [13, 13]]),
  record("t2", "e2e/c.spec.ts", [[1, 1], [4, 4], [10, 10], [13, 13]]),
  { id: "t3", spec: "e2e/d.spec.ts", loaded: ["src/lib/other.ts"], exercised: [], requests: ["static/logo.png"] },
], [{
  path: "src/lib/x.ts", blob: BLOB, aligned: true,
  mapped: [[1, 1], [4, 13]],
  blocks: [[1, 13], [4, 9], [5, 7], [10, 12]],
}], { commit: "c0ffee", generatedAt: new Date().toISOString() });

const known = new Set(["src/lib/x.ts", "src/lib/y.ts"]);
const exists = (p: string) => known.has(p);

/** Replace base lines [start, start+count) with `lines`, as git diff -U0 would. */
function edit(start: number, count: number, lines: string[]): ChangedFile {
  const base = X.split("\n");
  const head = [...base.slice(0, start - 1 + (count === 0 ? 1 : 0)), ...lines, ...base.slice(start - 1 + count + (count === 0 ? 1 : 0))];
  const headStart = count === 0 ? start + 1 : start;
  return {
    path: "src/lib/x.ts", status: "modified", baseText: X, headText: head.join("\n"), baseBlob: BLOB,
    hunks: [{ baseStart: start, baseCount: count, headStart: lines.length === 0 ? start - 1 : headStart, headCount: lines.length }],
  };
}
const run = (changed: ChangedFile[], extra: Partial<Parameters<typeof selectFromImpact>[0]> = {}) => {
  const out = selectFromImpact({ impact, changed, ts, exists, ...extra });
  return { all: out.all, specs: [...out.specs].sort(), zero: out.zeroCoverage, fileLevel: out.fileLevel, hunkLevel: out.hunkLevel };
};

describe("selectFromImpact: hunk level", () => {
  it("selects only the tests that ran a changed line", () => {
    expect(run([edit(6, 1, ["    return helper(n) + 1;"])]).specs).toEqual(["e2e/b.spec.ts"]);
    expect(run([edit(8, 1, ["  return -1;"])]).specs).toEqual(["e2e/a.spec.ts"]);
  });

  it("selects every loader for a module-level change", () => {
    expect(run([edit(13, 1, ["export const K = 2;"])]).specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
  });

  it("selects nothing for type-only and comment-only changes", () => {
    const r = run([edit(3, 1, ["export interface Shape { a: string }"]), edit(2, 1, ["// a different comment"])]);
    expect(r).toMatchObject({ all: [], specs: [] });
  });

  it("places a pure insertion in its smallest enclosing block", () => {
    // After line 5, inside the `if` block: only the test that entered it,
    // not the one that evaluated its condition.
    expect(run([edit(5, 0, ["    log(n);"])]).specs).toEqual(["e2e/b.spec.ts"]);
    // After line 4, in alpha's body: every caller, not the module's loaders.
    expect(run([edit(4, 0, ["  log(n);"])]).specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    // After the last line, at the top level: every loader.
    expect(run([edit(13, 0, ["log();"])]).specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
  });

  it("falls back to the file level for code no test ran, and reports it", () => {
    const r = run([edit(11, 1, ["  return 3;"])]);
    expect(r.zero).toEqual(["src/lib/x.ts:11"]);
    expect(r.fileLevel).toEqual(["src/lib/x.ts"]);
    expect(r.specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
  });

  it("treats a new, unreferenced, non-exported function as a binding only", () => {
    expect(run([edit(13, 0, ["function gamma() {", "  return 4;", "}"])]).specs).toEqual([]);
  });

  it("does not treat a declaration that shadows an existing name as a binding", () => {
    // `helper` already appears in the file: a new declaration rebinds it.
    expect(run([edit(13, 0, ["function helper() {", "  return 4;", "}"])]).specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
  });

  it("does not treat a new export of a namespace-imported module as a binding", () => {
    const r = run([edit(13, 0, ["export function gamma() {", "  return 4;", "}"])], { namespaceTargets: new Set(["src/lib/x.ts"]) });
    expect(r.specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
  });

  it("treats re-importing an already-loaded module as a binding change", () => {
    expect(run([edit(1, 1, ['import { helper, other } from "./y";'])]).specs).toEqual([]);
  });

  it("selects every loader for an import of a module some loader never evaluated", () => {
    const r = run([edit(1, 0, ['import "./z-side-effect";'])]);
    expect(r.specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
  });

  it("uses the file level when the base text differs from the mapped version", () => {
    const r = run([{ ...edit(6, 1, ["    return 9;"]), baseBlob: "other" }]);
    expect(r.fileLevel).toEqual(["src/lib/x.ts"]);
    expect(r.specs).toHaveLength(3);
  });

  it("translates lines through a diff from the map's commit", () => {
    // Two lines were inserted above `alpha` on dev after the map was built.
    const shifted = X.split("\n");
    shifted.splice(2, 0, "// new 1", "// new 2");
    const base = shifted.join("\n");
    const head = base.replace("    return helper(n);", "    return helper(n) * 2;");
    const toMapLine = lineTranslator(invertHunks([{ baseStart: 2, baseCount: 0, headStart: 3, headCount: 2 }]));
    const r = run([{ path: "src/lib/x.ts", status: "modified", baseText: base, headText: head, baseBlob: "newer", toMapLine,
      hunks: [{ baseStart: 8, baseCount: 1, headStart: 8, headCount: 1 }] }]);
    expect(r.hunkLevel).toEqual(["src/lib/x.ts"]);
    expect(r.specs).toEqual(["e2e/b.spec.ts"]);
  });

  it("falls back when a changed line itself changed since the map", () => {
    const toMapLine = lineTranslator(invertHunks([{ baseStart: 6, baseCount: 1, headStart: 6, headCount: 1 }]));
    const r = run([{ ...edit(6, 1, ["    return 0;"]), baseBlob: "newer", toMapLine }]);
    expect(r.fileLevel).toEqual(["src/lib/x.ts"]);
  });

  it("handles a change git reports without hunks as module-level", () => {
    const r = run([{ ...edit(6, 1, ["x"]), hunks: [] }]);
    // No hunk carries a change: nothing to place, and no runtime proof needed.
    expect(r.all).toEqual([]);
  });

  it("stays fast and correct for a very large diff", () => {
    const big = Array.from({ length: 2000 }, (_, i) => edit(6, 1, [`    return ${i};`]));
    const started = performance.now();
    expect(run(big).specs).toEqual(["e2e/b.spec.ts"]);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("selectFromImpact: escalations and file level", () => {
  it("runs everything for a new file", () => {
    expect(run([{ path: "src/lib/new.ts", status: "added", baseText: null, headText: "export const a = 1;" }]).all)
      .toEqual(["new file, not in the impact map: src/lib/new.ts"]);
  });

  it("runs everything for a file no spec loaded", () => {
    expect(run([{ ...edit(6, 1, ["x"]), path: "src/lib/unseen.ts" }]).all[0]).toContain("absent from the impact map");
  });

  it("runs everything for a file the map lists with no spec", () => {
    const empty = { ...impact, files: { ...impact.files, "src/lib/x.ts": [] } };
    expect(selectFromImpact({ impact: empty, changed: [edit(6, 1, ["x"])], ts, exists }).all[0]).toContain("no spec");
  });

  it("selects every loader of a deleted file", () => {
    expect(run([{ path: "src/lib/x.ts", status: "deleted", baseText: X, headText: null }]).specs).toHaveLength(3);
  });

  it("ignores a module with no runtime code on either side, even if unmapped", () => {
    const types = "export interface A { a: number }\n";
    expect(run([{ path: "src/lib/types.ts", status: "modified", baseText: types, headText: types.replace("number", "string"), hunks: [] }]))
      .toMatchObject({ all: [], specs: [] });
  });

  it("maps assets through fetched files, else runs everything", () => {
    expect(run([{ path: "static/logo.png", status: "modified" }]).specs).toEqual(["e2e/d.spec.ts"]);
    expect(run([{ path: "src/app.css", status: "modified" }]).all[0]).toContain("no spec fetched");
    expect(run([{ path: "static/new.png", status: "added" }]).all[0]).toContain("new asset");
  });

  it("uses the file level when asked, or without TypeScript", () => {
    expect(run([edit(6, 1, ["x"])], { level: "file" }).specs).toHaveLength(3);
    expect(run([edit(6, 1, ["x"])], { ts: null }).specs).toHaveLength(3);
  });

  it("uses the file level for an unaligned source map", () => {
    const unaligned = { ...impact, lines: { "src/lib/x.ts": { ...impact.lines["src/lib/x.ts"], aligned: false } } };
    expect(selectFromImpact({ impact: unaligned, changed: [edit(6, 1, ["x"])], ts, exists }).fileLevel).toEqual(["src/lib/x.ts"]);
  });
});

describe("lineTranslator", () => {
  it("shifts lines after insertions and deletions and nulls changed lines", () => {
    const t = lineTranslator([
      { baseStart: 2, baseCount: 0, headStart: 3, headCount: 2 },
      { baseStart: 5, baseCount: 2, headStart: 8, headCount: 1 },
    ]);
    expect([1, 2, 3, 4, 5, 6, 7].map(t)).toEqual([1, 2, 5, 6, null, null, 8]);
  });
});
