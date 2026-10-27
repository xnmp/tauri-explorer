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

describe("selectFromImpact: function level", () => {
  const ALL3 = ["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"];
  const CALLERS = ["e2e/a.spec.ts", "e2e/b.spec.ts"];

  it("selects every test that entered the function around a change", () => {
    // Inside alpha: both callers, whichever branch they took; not the
    // loader that never called it.
    expect(run([edit(6, 1, ["    return helper(n) + 1;"])]).specs).toEqual(CALLERS);
    expect(run([edit(8, 1, ["  return -1;"])]).specs).toEqual(CALLERS);
    expect(run([edit(5, 0, ["    log(n);"])]).specs).toEqual(CALLERS);
    expect(run([edit(4, 0, ["  log(n);"])]).specs).toEqual(CALLERS);
  });

  it("selects every loader for a module-level change", () => {
    expect(run([edit(13, 1, ["export const K = 2;"])]).specs).toEqual(ALL3);
    expect(run([edit(13, 0, ["log();"])]).specs).toEqual(ALL3);
  });

  it("selects every loader for a change to a function's header or closing line", () => {
    expect(run([edit(4, 1, ["export function alpha(n: number, m = helper(0)) {"])]).specs).toEqual(ALL3);
    expect(run([edit(4, 1, ["function alpha(n: number) {"])]).specs).toEqual(ALL3);
    expect(run([edit(9, 1, ["}, 0;"])]).specs).toEqual(ALL3);
    // Rewriting the whole function touches its header too.
    expect(run([edit(4, 6, ["export function alpha(n: number) {", "  return n > 0 ? helper(n) : 0;", "}"])]).specs).toEqual(ALL3);
  });

  it("selects every loader when the new side reshapes the function (a split moves code to module level)", () => {
    expect(run([edit(7, 0, ["}", "export function split() {"])]).specs).toEqual(ALL3);
  });

  it("selects nothing for type-only and comment-only changes", () => {
    const r = run([edit(3, 1, ["export interface Shape { a: string }"]), edit(2, 1, ["// a different comment"])]);
    expect(r).toMatchObject({ all: [], specs: [] });
  });

  it("does not treat new code as a binding only: a new function at module level selects every loader", () => {
    expect(run([edit(13, 0, ["function gamma() {", "  return 4;", "}"])]).specs).toEqual(ALL3);
  });

  it("falls back to the file level for a function no test entered, and reports it", () => {
    const r = run([edit(11, 1, ["  return 3;"])]);
    expect(r.zero).toEqual(["src/lib/x.ts:11"]);
    expect(r.fileLevel).toEqual(["src/lib/x.ts"]);
    expect(r.specs).toEqual(ALL3);
  });

  describe("regressions: a new branch attached to an existing block (#1373 review, F1)", () => {
    // esbuild maps the block's closing brace and V8 attributes it to the
    // `then` block, so a block-level rule picked only the tests that took
    // the existing branch. Function level selects every test in the function.
    const select = (text: string, cover: Record<string, Array<[number, number]>>, hunk: { at: number, lines: string[] }) => {
      const records = Object.entries(cover).map(([id, lines]) => ({
        id, spec: `e2e/${id}.spec.ts`, title: [id], location: `e2e/${id}.spec.ts:1`,
        loaded: ["src/lib/k.ts"], exercised: ["src/lib/k.ts"], lines: { "src/lib/k.ts": lines },
      }));
      const n = text.split("\n").length;
      const kImpact = mergeImpact(records, [{ path: "src/lib/k.ts", blob: "k", aligned: true, mapped: [[1, n]], blocks: [[1, n]] }],
        { commit: "c0ffee", generatedAt: new Date().toISOString() });
      const base = text.split("\n");
      const head = [...base.slice(0, hunk.at), ...hunk.lines, ...base.slice(hunk.at)].join("\n");
      const out = selectFromImpact({ impact: kImpact, ts, exists, changed: [{
        path: "src/lib/k.ts", status: "modified", baseText: text, headText: head, baseBlob: "k",
        hunks: [{ baseStart: hunk.at, baseCount: 0, headStart: hunk.at + 1, headCount: hunk.lines.length }],
      }] });
      return [...out.specs].sort();
    };

    it("`else if` after an early return (window-keys.ts open-filter)", () => {
      const text = [
        "export function classify(event: KeyboardEvent, context: { input: boolean }) {", // 1
        "  const primary = event.ctrlKey;", //                                           2
        '  if (event.key === "f" && primary) {', //                                      3
        '    return "open-filter";', //                                                   4
        "  }", //                                                                         5
        '  if (context.input) return "pass";', //                                        6
        '  return "command";', //                                                         7
        "}", //                                                                           8
      ].join("\n");
      // ctrlF took the branch (its closing brace counted with it); other
      // keys skipped it; idle only loaded the module.
      const specs = select(text, { ctrlF: [[1, 5]], other: [[1, 3], [6, 8]], idle: [[1, 1]] },
        { at: 4, lines: ["  } else if (primary && event.shiftKey) {", '    return "pass";'] });
      expect(specs).toEqual(["e2e/ctrlF.spec.ts", "e2e/other.spec.ts"]);
    });

    it("`else { throw }` on a branch the browser never takes (common.ts invoke)", () => {
      const text = [
        "let cached = false;", //                                   1
        "export async function invoke(cmd: string) {", //           2
        "  if (!cached && isTauri()) {", //                         3
        "    cached = true;", //                                    4
        "  }", //                                                   5
        "  if (cached) {", //                                       6
        "    return tauri(cmd);", //                                7
        "  }", //                                                   8
        "  return mock(cmd);", //                                   9
        "}", //                                                     10
      ].join("\n");
      const specs = select(text, { caller: [[1, 3], [6, 6], [8, 10]], idle: [[1, 2]] },
        { at: 4, lines: ["  } else {", '    throw new Error("not in Tauri");'] });
      expect(specs).toEqual(["e2e/caller.spec.ts"]);
    });
  });

  describe("import edits", () => {
    it("treats a new binding of an already-loaded module, under a new name, as a binding only", () => {
      expect(run([edit(1, 1, ['import { helper, other } from "./y";'])]).specs).toEqual([]);
    });

    it("selects every loader when a binding keeps its local name but changes what it imports", () => {
      expect(run([edit(1, 1, ['import { other as helper } from "./y";'])]).specs).toEqual(ALL3);
      expect(run([edit(1, 1, ['import * as helper from "./y";'])]).specs).toEqual(ALL3);
      expect(run([edit(1, 1, ['import helper from "./y";'])]).specs).toEqual(ALL3);
    });

    it("selects every loader when a new binding shadows a name the file already uses (a global included)", () => {
      expect(run([edit(1, 1, ['import { helper, alpha } from "./y";'])]).specs).toEqual(ALL3);
    });

    it("selects every loader when an import or a binding is removed (Svelte keeps unused value imports)", () => {
      expect(run([edit(1, 1, ['import {} from "./y";'])]).specs).toEqual(ALL3);
      expect(run([edit(1, 1, [])]).specs).toEqual(ALL3);
    });

    it("selects every loader when imports are reordered (ESM evaluation order)", () => {
      const base = ['import { helper } from "./y";', 'import { z } from "./z";', "export const K = helper(z);"].join("\n");
      const head = ['import { z } from "./z";', 'import { helper } from "./y";', "export const K = helper(z);"].join("\n");
      const r = run([{ path: "src/lib/x.ts", status: "modified", baseText: base, headText: head, baseBlob: "newer",
        toMapLine: (n: number) => n, hunks: [{ baseStart: 1, baseCount: 2, headStart: 1, headCount: 2 }] }]);
      expect(r.specs).toEqual(ALL3);
    });

    it("never treats a side-effect import, a re-export or `import { type A }` of an unloaded module as inert", () => {
      expect(run([edit(1, 0, ['import "./y";'])]).specs).toEqual(ALL3);
      expect(run([edit(13, 0, ['export { helper as h2 } from "./y";'])]).specs).toEqual(ALL3);
      // verbatimModuleSyntax keeps it as `import {} from "./unseen"`.
      expect(run([edit(1, 0, ['import { type U } from "./unseen";'])]).specs).toEqual(ALL3);
      expect(run([edit(1, 0, ['import type { U } from "./unseen";'])]).specs).toEqual([]);
    });

    it("selects every loader for an import of a module some loader never evaluated", () => {
      expect(run([edit(1, 0, ['import { side } from "./z-side-effect";'])]).specs).toEqual(ALL3);
    });
  });

  it("selects every loader for a Svelte style or markup change", () => {
    const base = ["<script>", "  let a = 1;", "  function f() {", "    a++;", "  }", "</script>", "<p>{a}</p>", "<style>", "  :global(p) { color: red; }", "</style>"].join("\n");
    const svelteImpact = mergeImpact([
      { id: "s0", spec: "e2e/s.spec.ts", title: ["s0"], location: "e2e/s.spec.ts:1", loaded: ["src/lib/S.svelte"], exercised: ["src/lib/S.svelte"], lines: { "src/lib/S.svelte": [[1, 7]] } },
      { id: "s1", spec: "e2e/t.spec.ts", title: ["s1"], location: "e2e/t.spec.ts:1", loaded: ["src/lib/S.svelte"], exercised: ["src/lib/S.svelte"], lines: { "src/lib/S.svelte": [[1, 2]] } },
    ], [{ path: "src/lib/S.svelte", blob: "s", aligned: true, mapped: [[1, 7]], blocks: [[1, 10]] }],
    { commit: "c0ffee", generatedAt: new Date().toISOString() });
    const sel = (headText: string, line: number) => [...selectFromImpact({ impact: svelteImpact, ts, exists, changed: [{
      path: "src/lib/S.svelte", status: "modified", baseText: base, headText, baseBlob: "s",
      hunks: [{ baseStart: line, baseCount: 1, headStart: line, headCount: 1 }],
    }] }).specs].sort();
    expect(sel(base.replace("red", "blue"), 9)).toEqual(["e2e/s.spec.ts", "e2e/t.spec.ts"]);
    expect(sel(base.replace("<p>{a}</p>", "<b>{a}</b>"), 7)).toEqual(["e2e/s.spec.ts", "e2e/t.spec.ts"]);
    // Inside the script's function: the tests that entered it.
    expect(sel(base.replace("a++;", "a += 2;"), 4)).toEqual(["e2e/s.spec.ts"]);
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
    expect(r.specs).toEqual(CALLERS);
  });

  it("uses the file level when the function's header or end changed since the map", () => {
    const toMapLine = lineTranslator(invertHunks([{ baseStart: 4, baseCount: 1, headStart: 4, headCount: 1 }]));
    const r = run([{ ...edit(6, 1, ["    return 0;"]), baseBlob: "newer", toMapLine }]);
    expect(r.fileLevel).toEqual(["src/lib/x.ts"]);
    expect(r.specs).toEqual(ALL3);
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
    expect(run(big).specs).toEqual(CALLERS);
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
