import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mergeImpact } from "../scripts/impact-coverage.mjs";
import { invertHunks, lineTranslator, selectFromImpact, withDrift, type ChangedFile } from "../scripts/impact-select.mjs";

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

  it("places a function header change by the function's callers, not its loaders", () => {
    // Line 4 is "covered" by every loader (the module creates alpha), but a
    // new parameter default only runs when alpha is called.
    expect(run([edit(4, 1, ["export function alpha(n: number, m = helper(0)) {"])]).specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    // Rewriting the whole function: still only its callers.
    const whole = run([edit(4, 6, ["export function alpha(n: number) {", "  return n > 0 ? helper(n) : 0;", "}"])]);
    expect(whole.specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
  });

  it("selects every loader when a function's name does not survive", () => {
    expect(run([edit(4, 1, ["export function alpha2(n: number) {"])]).specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
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

  describe("a new method on an object", () => {
    const API = ["export const api = {", "  a() {", "    return 1;", "  },", "};"].join("\n");
    const apiImpact = mergeImpact([
      { id: "u0", spec: "e2e/u.spec.ts", title: ["u0"], location: "e2e/u.spec.ts:1", loaded: ["src/lib/api.ts"], exercised: ["src/lib/api.ts"], lines: { "src/lib/api.ts": [[1, 5]] } },
      { id: "v0", spec: "e2e/v.spec.ts", title: ["v0"], location: "e2e/v.spec.ts:1", loaded: ["src/lib/api.ts"], exercised: ["src/lib/api.ts"], lines: { "src/lib/api.ts": [[1, 2], [5, 5]] } },
    ], [{ path: "src/lib/api.ts", blob: "api", aligned: true, mapped: [[1, 5]], blocks: [[1, 5], [2, 4]] }],
    { commit: "c0ffee", generatedAt: new Date().toISOString() });
    const insert = (lines: string[]) => {
      const head = [...API.split("\n").slice(0, 4), ...lines, "};"].join("\n");
      const out = selectFromImpact({ impact: apiImpact, ts, exists, changed: [{
        path: "src/lib/api.ts", status: "modified", baseText: API, headText: head, baseBlob: "api",
        hunks: [{ baseStart: 4, baseCount: 0, headStart: 5, headCount: lines.length }],
      }] });
      return [...out.specs].sort();
    };

    it("selects every user of the object, even for a name nothing mentions (enumeration and spreads reach it)", () => {
      expect(insert(["  zzqNew() {", "    return 2;", "  },"])).toEqual(["e2e/u.spec.ts", "e2e/v.spec.ts"]);
      expect(insert(["  get zzqBoom() {", "    throw new Error();", "  },"])).toEqual(["e2e/u.spec.ts", "e2e/v.spec.ts"]);
    });
  });

  describe("import edits", () => {
    const ALL3 = ["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"];
    it("selects when a binding keeps its local name but changes what it imports", () => {
      expect(run([edit(1, 1, ['import { other as helper } from "./y";'])]).specs).toEqual(ALL3);
      expect(run([edit(1, 1, ['import * as helper from "./y";'])]).specs).toEqual(ALL3);
      expect(run([edit(1, 1, ['import helper from "./y";'])]).specs).toEqual(ALL3);
    });

    it("selects when a new binding shadows a name the file already uses (a global included)", () => {
      expect(run([edit(1, 1, ['import { helper, alpha } from "./y";'])]).specs).toEqual(ALL3);
    });

    it("selects when a dropped binding is still used", () => {
      expect(run([edit(1, 1, ['import {} from "./y";'])]).specs).toEqual(ALL3);
    });

    it("never treats a side-effect import or a re-export as a binding", () => {
      expect(run([edit(1, 0, ['import "./y";'])]).specs).toEqual(ALL3);
      expect(run([edit(13, 0, ['export { helper as h2 } from "./y";'])]).specs).toEqual(ALL3);
    });
  });

  it("does not place a header by its callers when the function's shape changes", () => {
    // Dropping `export` breaks importers at link time; an accessor runs on access.
    const ALL3 = ["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"];
    expect(run([edit(4, 1, ["function alpha(n: number) {"])]).specs).toEqual(ALL3);
    expect(run([edit(4, 1, ["export async function alpha(n: number) {"])]).specs).toEqual(ALL3);
  });

  it("selects every loader for a Svelte style change, wherever the block sits", () => {
    const base = ["<script>", "  let a = 1;", "  function f() {", "    a++;", "  }", "</script>", "<style>", "  :global(p) { color: red; }", "</style>", "<p>{a}</p>"].join("\n");
    const svelteImpact = mergeImpact([
      { id: "s0", spec: "e2e/s.spec.ts", title: ["s0"], location: "e2e/s.spec.ts:1", loaded: ["src/lib/S.svelte"], exercised: ["src/lib/S.svelte"], lines: { "src/lib/S.svelte": [[1, 4], [10, 10]] } },
      { id: "s1", spec: "e2e/t.spec.ts", title: ["s1"], location: "e2e/t.spec.ts:1", loaded: ["src/lib/S.svelte"], exercised: ["src/lib/S.svelte"], lines: { "src/lib/S.svelte": [[1, 2]] } },
    ], [{ path: "src/lib/S.svelte", blob: "s", aligned: true, mapped: [[1, 6], [10, 10]], blocks: [[1, 10], [2, 10], [3, 5]] }],
    { commit: "c0ffee", generatedAt: new Date().toISOString() });
    const out = selectFromImpact({ impact: svelteImpact, ts, exists, changed: [{
      path: "src/lib/S.svelte", status: "modified", baseText: base, headText: base.replace("red", "blue"), baseBlob: "s",
      hunks: [{ baseStart: 8, baseCount: 1, headStart: 8, headCount: 1 }],
    }] });
    expect([...out.specs].sort()).toEqual(["e2e/s.spec.ts", "e2e/t.spec.ts"]);
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

  it("places a line edited since the map in the block around its shared neighbours", () => {
    const toMapLine = lineTranslator(invertHunks([{ baseStart: 6, baseCount: 1, headStart: 6, headCount: 1 }]));
    const r = run([{ ...edit(6, 1, ["    return 0;"]), baseBlob: "newer", toMapLine }]);
    expect(r.hunkLevel).toEqual(["src/lib/x.ts"]);
    expect(r.specs).toEqual(["e2e/b.spec.ts"]);
  });

  it("widens to the loaders when the edit since the map reaches the file's edges", () => {
    // Every base line changed since the map: no shared neighbour to place it.
    const toMapLine = lineTranslator(invertHunks([{ baseStart: 1, baseCount: 13, headStart: 1, headCount: 13 }]));
    const r = run([{ ...edit(6, 1, ["    return 0;"]), baseBlob: "newer", toMapLine }]);
    expect(r.fileLevel).toEqual(["src/lib/x.ts"]);
    expect(r.specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
  });

  it("does not treat a Svelte comment edited since the map as inert", () => {
    const base = "<script>\n  let a = 1;\n</script>\n<p>{a}</p>\n<!-- note -->\n<p>end</p>";
    const svelteImpact = mergeImpact([
      { id: "s0", spec: "e2e/s.spec.ts", title: ["s0"], location: "e2e/s.spec.ts:1", loaded: ["src/lib/S.svelte"], exercised: ["src/lib/S.svelte"], lines: { "src/lib/S.svelte": [[1, 6]] } },
    ], [{ path: "src/lib/S.svelte", blob: "s", aligned: true, mapped: [[1, 6]], blocks: [[1, 6]] }], { commit: "c0ffee", generatedAt: new Date().toISOString() });
    const toMapLine = lineTranslator(invertHunks([{ baseStart: 5, baseCount: 1, headStart: 5, headCount: 1 }]));
    const out = selectFromImpact({ impact: svelteImpact, ts, exists, changed: [{
      path: "src/lib/S.svelte", status: "modified", baseText: base, headText: base.replace("<!-- note -->", "<!-- other -->"),
      baseBlob: "newer", toMapLine, hunks: [{ baseStart: 5, baseCount: 1, headStart: 5, headCount: 1 }],
    }] });
    expect([...out.specs]).toEqual(["e2e/s.spec.ts"]);
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

describe("withDrift", () => {
  const sel = (over: Partial<ReturnType<typeof selectFromImpact>> = {}) => ({
    all: [] as string[], specs: new Set<string>(), tests: new Set<number>(), zeroCoverage: [] as string[],
    fileLevel: [] as string[], hunkLevel: [] as string[], ...over,
  });

  it("adds the tests that ran code changed since the map, and specs edited since then", () => {
    const out = withDrift(sel({ specs: new Set(["e2e/a.spec.ts"]), tests: new Set([0]) }),
      sel({ specs: new Set(["e2e/b.spec.ts"]), tests: new Set([1]) }), ["e2e/c.spec.ts"]);
    expect([...out.specs].sort()).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"]);
    expect([...out.tests].sort()).toEqual([0, 1]);
  });

  it("selects ALL when the drift cannot be placed, and keeps only the PR's unexecuted hunks", () => {
    const out = withDrift(sel({ zeroCoverage: ["src/a.ts:3"] }),
      sel({ all: ["new file, not in the impact map: src/n.ts"], zeroCoverage: ["src/b.ts:9"] }), []);
    expect(out.all).toEqual(["since the impact map's commit: new file, not in the impact map: src/n.ts"]);
    expect(out.zeroCoverage).toEqual(["src/a.ts:3"]);
  });
});
