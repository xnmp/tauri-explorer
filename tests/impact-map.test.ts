import { encode } from "@jridgewell/sourcemap-codec";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  MAX_MAP_AGE_HOURS,
  decodeSet,
  encodeSet,
  expectedTests,
  fromRuns,
  loadImpactMap,
  mergeImpact,
  repoPathFromUrl,
  scriptExercised,
  toRuns,
} from "../scripts/impact-coverage.mjs";
import { gitBlobId, reduceCoverage, requestedRepoFile } from "../scripts/impact-collect.mjs";
import { inlineSourceMap, scriptLines } from "../scripts/impact-lines.mjs";
import { factsOf, parseHunks, resolveSpecifier } from "../scripts/impact-regions.mjs";

const ORIGIN = "http://localhost:1420";

describe("repoPathFromUrl", () => {
  it.each([
    [`${ORIGIN}/src/lib/domain/path.ts`, "src/lib/domain/path.ts"],
    [`${ORIGIN}/src/lib/components/FileItem.svelte?svelte&type=style&lang.css`, "src/lib/components/FileItem.svelte"],
    [`${ORIGIN}/src/lib/state/x.svelte.ts?t=1712345`, "src/lib/state/x.svelte.ts"],
    [`${ORIGIN}/src/lib/components/icons/a%20b.svg?import&url`, "src/lib/components/icons/a b.svg"],
    [`${ORIGIN}/@fs/home/u/repo/src/lib/x.ts`, "src/lib/x.ts"],
  ])("maps %s", (url, path) => expect(repoPathFromUrl(url)).toBe(path));

  it.each([
    `${ORIGIN}/node_modules/.vite/deps/svelte.js?v=1`,
    `${ORIGIN}/@vite/client`,
    `${ORIGIN}/@fs/home/u/repo/.svelte-kit/generated/client/app.js`,
    `${ORIGIN}/@id/__x00__virtual:thing`,
    `${ORIGIN}/src/../package.json`,
    `${ORIGIN}/?path=/home/user`,
    "data:text/javascript,1",
    "not a url",
    `${ORIGIN}/src/%E0%A4%A.ts`,
  ])("ignores %s", (url) => expect(repoPathFromUrl(url)).toBeNull());
});

describe("scriptExercised", () => {
  const top = { functionName: "", ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] };
  it("is false when only the top level ran", () => {
    expect(scriptExercised({ url: "", functions: [top, { functionName: "f", ranges: [{ startOffset: 10, endOffset: 20, count: 0 }] }] })).toBe(false);
  });
  it("is true when any other function ran", () => {
    expect(scriptExercised({ url: "", functions: [top, { functionName: "f", ranges: [{ startOffset: 10, endOffset: 20, count: 2 }] }] })).toBe(true);
  });
  it("tolerates missing or empty function lists", () => {
    expect(scriptExercised({ url: "", functions: [] })).toBe(false);
    expect(scriptExercised({ url: "" } as never)).toBe(false);
  });
});

describe("test sets and runs", () => {
  it.each([[[]], [[0]], [[3, 1, 2]], [Array.from({ length: 500 }, (_, i) => i * 3)]])("round-trips %#", (set) => {
    expect(decodeSet(encodeSet(set, 2000))).toEqual([...new Set(set)].sort((a, b) => a - b));
  });
  it("chooses the shorter encoding", () => {
    expect(encodeSet([5], 4000).startsWith("l")).toBe(true);
    expect(encodeSet(Array.from({ length: 3000 }, (_, i) => i), 4000).startsWith("b")).toBe(true);
  });
  it("rejects unknown encodings", () => {
    expect(() => decodeSet("x12")).toThrow();
    expect(() => decodeSet(5 as never)).toThrow();
  });
  it("converts line runs", () => {
    expect(toRuns([5, 1, 2, 3, 9, 3])).toEqual([[1, 3], [5, 5], [9, 9]]);
    expect(fromRuns([[1, 3], [7, 7]])).toEqual([1, 2, 3, 7]);
  });
});

/** A generated module whose line i comes from original line i, with an inline map. */
function identityModule(original: string, url = `${ORIGIN}/src/lib/x.ts`) {
  const lines = original.split("\n");
  const mappings = encode(lines.map((l, i) => (l.trim() ? [[0, 0, i, 0]] : [])) as never);
  const map = { version: 3, sources: ["x.ts"], sourcesContent: [original], mappings, names: [] };
  const source = `${original}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  return { url, source };
}

describe("scriptLines", () => {
  const original = "const a = 1;\nfunction f() {\n  return 2;\n}\nfunction g() {\n  return 3;\n}\ng();";
  const offset = (line: number) => original.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
  const script = (counts: { f: number; g: number }) => ({
    ...identityModule(original),
    functions: [
      { functionName: "", ranges: [{ startOffset: 0, endOffset: original.length, count: 1 }] },
      { functionName: "f", ranges: [{ startOffset: offset(2), endOffset: offset(5) - 1, count: counts.f }] },
      { functionName: "g", ranges: [{ startOffset: offset(5), endOffset: offset(8) - 1, count: counts.g }] },
    ],
  });

  it("maps covered blocks to original lines", () => {
    const lines = scriptLines(script({ f: 0, g: 1 }))!;
    expect(fromRuns(lines.covered)).toEqual([1, 5, 6, 7, 8]);
    expect(fromRuns(lines.mapped)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lines.blocks).toEqual(expect.arrayContaining([[1, 8], [2, 4], [5, 7]]));
    expect(lines.sourceText).toBe(original);
  });

  it("returns null without a usable inline map", () => {
    expect(scriptLines({ url: "", source: "x()", functions: [] })).toBeNull();
    expect(scriptLines({ url: "", source: "x()\n//# sourceMappingURL=data:application/json;base64,bm9wZQ==", functions: [] })).toBeNull();
    expect(inlineSourceMap("x")).toBeNull();
  });

  it("reduces a test's scripts to loaded, exercised and covered files", () => {
    const disk = Buffer.from(original);
    const reduced = reduceCoverage([
      script({ f: 0, g: 1 }),
      { url: `${ORIGIN}/src/lib/C.svelte?svelte&type=style&lang.css`, source: "x", functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }] },
      { url: `${ORIGIN}/node_modules/.vite/deps/svelte.js`, source: "y", functions: [] },
      { url: `${ORIGIN}/src/lib/never.ts`, source: "z", functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 1, count: 0 }] }] },
    ], { root: "/nonexistent", readFile: (p) => (p === "src/lib/x.ts" ? disk : null) });
    expect(reduced.loaded).toEqual(["src/lib/C.svelte", "src/lib/x.ts"]);
    expect(reduced.exercised).toEqual(["src/lib/x.ts"]);
    expect(reduced.lines["src/lib/x.ts"]).toEqual([[1, 1], [5, 8]]);
    expect(reduced.metas).toEqual([expect.objectContaining({ path: "src/lib/x.ts", blob: gitBlobId(disk), aligned: true })]);
  });

  it("marks a module whose served text differs from the checkout as unaligned", () => {
    const reduced = reduceCoverage([script({ f: 1, g: 1 })], { root: "/x", readFile: () => Buffer.from("changed") });
    expect(reduced.metas[0].aligned).toBe(false);
  });
});

describe("gitBlobId and requests", () => {
  it("matches git hash-object", () => {
    expect(gitBlobId("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
  it("keeps same-origin non-module files only", () => {
    expect(requestedRepoFile(`${ORIGIN}/src/lib/icons/a.svg`, ORIGIN, "/x")).toBe("src/lib/icons/a.svg");
    expect(requestedRepoFile(`${ORIGIN}/src/lib/a.ts`, ORIGIN, "/x")).toBeNull();
    expect(requestedRepoFile("https://example.com/src/lib/a.svg", ORIGIN, "/x")).toBeNull();
    expect(requestedRepoFile(`${ORIGIN}/node_modules/x.js`, ORIGIN, "/x")).toBeNull();
    expect(requestedRepoFile(`${ORIGIN}/missing-static.png`, ORIGIN, "/nonexistent")).toBeNull();
  });
});

describe("mergeImpact", () => {
  const record = (id: string, spec: string, loaded: string[], lines: Record<string, Array<[number, number]>> = {}) =>
    ({ id, spec, title: [id], location: `${spec}:1`, loaded, exercised: loaded.slice(0, 1), lines, requests: ["static/a.png"] });
  const meta = (path: string, blob: string) => ({ path, blob, aligned: true, mapped: [[1, 9]] as Array<[number, number]>, blocks: [[1, 9]] as Array<[number, number]> });

  it("unions attempts and files per spec and per line", () => {
    const map = mergeImpact([
      record("t1", "e2e/a.spec.ts", ["src/x.ts", "src/y.ts"], { "src/x.ts": [[1, 3]] }),
      record("t1", "e2e/a.spec.ts", ["src/x.ts"], { "src/x.ts": [[4, 4]] }),
      record("t2", "e2e/b.spec.ts", ["src/x.ts"], { "src/x.ts": [[3, 5]] }),
    ], [meta("src/x.ts", "b1")], { commit: "abc", generatedAt: "2026-10-24T00:00:00Z" });
    expect(map.tests.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(map.specs).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    expect(map.files["src/x.ts"]).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    expect(map.files["src/y.ts"]).toEqual(["e2e/a.spec.ts"]);
    expect(map.assets["static/a.png"]).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    const x = map.lines["src/x.ts"];
    expect(decodeSet(map.sets[x.tests])).toEqual([0, 1]);
    const byLine = x.cover.flatMap(([a, b, s]) => fromRuns([[a, b]]).map((n) => [n, decodeSet(map.sets[s])]));
    expect(byLine).toEqual([[1, [0]], [2, [0]], [3, [0, 1]], [4, [0, 1]], [5, [1]]]);
    expect(map.lines["src/y.ts"]).toBeUndefined();
  });

  it("marks a spec incomplete when an executed test left no record", () => {
    const map = mergeImpact([record("t1", "e2e/a.spec.ts", ["src/x.ts"])], [],
      { expected: [{ id: "t1", spec: "e2e/a.spec.ts" }, { id: "t9", spec: "e2e/a.spec.ts" }, { id: "t2", spec: "e2e/b.spec.ts" }] });
    expect(map.incomplete).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    expect(map.specs).toEqual([]);
  });

  it("reads the executed tests from a Playwright JSON report", () => {
    const report = { config: {}, suites: [{ specs: [], suites: [{ specs: [
      { id: "ran", file: "a.spec.ts", tests: [{ results: [{ status: "failed" }] }] },
      { id: "skip", file: "a.spec.ts", tests: [{ results: [{ status: "skipped" }] }] },
      { id: "none", file: "a.spec.ts", tests: [{ results: [] }] },
    ] }] }] };
    expect(expectedTests(report)).toEqual([{ id: "ran", spec: "e2e/a.spec.ts" }]);
    expect(expectedTests(null)).toEqual([]);
  });

  it("drops line data for a file served in two versions", () => {
    const map = mergeImpact([record("t1", "e2e/a.spec.ts", ["src/x.ts"], { "src/x.ts": [[1, 1]] })],
      [meta("src/x.ts", "b1"), meta("src/x.ts", "b2")]);
    expect(map.lines["src/x.ts"]).toBeUndefined();
    expect(map.files["src/x.ts"]).toEqual(["e2e/a.spec.ts"]);
  });
});

describe("loadImpactMap", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const valid = { version: 1, commit: "abc", generatedAt: "2026-10-24T03:00:00Z", specs: ["e2e/a.spec.ts"], tests: [],
    files: { "src/x.ts": ["e2e/a.spec.ts"] }, exercised: {}, assets: {}, lines: {}, sets: [] };
  const load = (v: unknown) => loadImpactMap(typeof v === "string" ? v : JSON.stringify(v), { now });

  it("accepts a fresh, well-formed map", () => expect(load(valid)).toHaveProperty("map"));
  it.each([
    [null, "no impact map"],
    ["{", "not valid JSON"],
    [[], "not an object"],
    [{ ...valid, version: 2 }, "version"],
    [{ ...valid, files: { "src/x.ts": "e2e/a.spec.ts" } }, "malformed"],
    [{ ...valid, specs: [] }, "empty"],
    [{ ...valid, files: {} }, "empty"],
    [{ ...valid, generatedAt: "yesterday" }, "generatedAt"],
    [{ ...valid, generatedAt: new Date(now.getTime() - (MAX_MAP_AGE_HOURS + 1) * 3_600_000).toISOString() }, "old"],
    [{ ...valid, generatedAt: "2026-10-25T12:00:00Z" }, "future"],
  ])("rejects %#", (input, reason) => {
    const result = input === null ? loadImpactMap(null, { now }) : load(input);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(reason);
  });
});

describe("source facts", () => {
  const kinds = (file: string, text: string) => factsOf(ts, file, text)!.lines.map((l) => l.kind);

  it("classifies TypeScript lines", () => {
    const text = [
      'import { a } from "./a";',
      'import type { T } from "./t";',
      "// comment",
      "export interface I { x: number }",
      "export const X = 5;",
      "let y: Map<string,",
      "  number> = new Map();",
      "const s = `it's",
      "  don't`;",
      "",
    ].join("\n");
    expect(kinds("src/x.ts", text)).toEqual(["import", "type", "trivia", "type", "code", "code", "code", "code", "code", "trivia"]);
    expect(factsOf(ts, "src/x.ts", text)!.lines[0].specifier).toBe("./a");
  });

  it("finds function declarations with names and export state", () => {
    const text = "export function a() {\n  return 1;\n}\nconst b = () => {\n  return 2;\n};\nfunction outer() {\n  function inner() {}\n}";
    expect(factsOf(ts, "src/x.ts", text)!.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "a", exported: true, start: 1, end: 3 }),
      expect.objectContaining({ name: "b", exported: false, start: 4, end: 6 }),
      expect.objectContaining({ name: "inner", start: 8, end: 8 }),
    ]));
  });

  it("classifies Svelte script content and treats markup and styles as code", () => {
    const text = '<script lang="ts">\n  import type { T } from "./t";\n  let x = $state(0);\n</script>\n\n<div>{x}</div>\n<style>\n  .a { color: red; }\n</style>';
    expect(kinds("src/C.svelte", text)).toEqual(["code", "type", "code", "code", "trivia", "code", "code", "code", "code"]);
  });

  it("degrades to code without TypeScript or for unparseable text", () => {
    expect(factsOf(null, "src/x.ts", "// c\nx()")!.lines.map((l) => l.kind)).toEqual(["code", "code"]);
    expect(factsOf(ts, "src/x.css", "a{}")).toBeNull();
  });

  it("parses git hunks", () => {
    expect(parseHunks("@@ -3,0 +4,2 @@ x\n+a\n+b\n@@ -10 +12 @@\n-c\n+d")).toEqual([
      { baseStart: 3, baseCount: 0, headStart: 4, headCount: 2 },
      { baseStart: 10, baseCount: 1, headStart: 12, headCount: 1 },
    ]);
    expect(parseHunks("Binary files differ")).toEqual([]);
  });

  it("resolves import specifiers", () => {
    const known = new Set(["src/lib/a.ts", "src/lib/C.svelte", "src/lib/s.svelte.ts", "src/lib/d/index.ts"]);
    const exists = (p: string) => known.has(p);
    expect(resolveSpecifier("src/lib/x.ts", "./a", exists)).toBe("src/lib/a.ts");
    expect(resolveSpecifier("src/lib/x.ts", "./a.js", exists)).toBe("src/lib/a.ts");
    expect(resolveSpecifier("src/lib/sub/x.ts", "../C.svelte", exists)).toBe("src/lib/C.svelte");
    expect(resolveSpecifier("src/routes/x.ts", "$lib/s.svelte", exists)).toBe("src/lib/s.svelte.ts");
    expect(resolveSpecifier("src/lib/x.ts", "./d", exists)).toBe("src/lib/d/index.ts");
    expect(resolveSpecifier("src/lib/x.ts", "svelte", exists)).toBeNull();
  });
});
