import { encode } from "@jridgewell/sourcemap-codec";
import { describe, expect, it } from "vitest";
import { chunkModules, unbundledModules } from "../scripts/e2e-browser-build.mjs";
import { bundleSourcePath, chunkCoverage, chunkEvaluated, chunkSegments } from "../scripts/impact-bundle.mjs";
import { coverageOrigins, reduceCoverage } from "../scripts/impact-collect.mjs";
import { mapServer, mergeImpact } from "../scripts/impact-coverage.mjs";
import { pickMapArtifact, trustedProducer } from "../scripts/impact-map-source.mjs";

const CHUNK = "_app/immutable/chunks/x.js";
const UP = "../../../../../../";

// A two-module chunk, one generated line per original line:
//   0: function a(){return 1}     <- src/lib/a.ts line 1
//   1: function b(){return 2}     <- src/lib/b.ts line 1
//   2: b();                       <- src/lib/b.ts line 3
//   3: lodash                     <- node_modules (ignored)
const code = ["function a(){return 1}", "function b(){return 2}", "b();", "lodash"].join("\n");
const starts = [0, 23, 46, 51];
const map = {
  sources: [`${UP}src/lib/a.ts`, `${UP}src/lib/b.ts`, `${UP}node_modules/lodash/x.js`],
  sourcesContent: ["export function a() {}\n", "b\n\nb()\n", null],
  mappings: encode([
    [[0, 0, 0, 0], [13, 0, 0, 10]],
    [[0, 1, 0, 0], [13, 1, 0, 10]],
    [[0, 1, 2, 0]],
    [[0, 2, 0, 0]],
  ]),
};
const fn = (start: number, end: number, count: number) => ({ ranges: [{ startOffset: start, endOffset: end, count }] });
const top = fn(0, code.length, 1);
const aFn = fn(starts[0], starts[0] + 22, 0);
const bFn = fn(starts[1], starts[1] + 22, 1);

describe("bundleSourcePath", () => {
  it("resolves map sources against SvelteKit's client output directory", () => {
    expect(bundleSourcePath(CHUNK, `${UP}src/lib/a.ts`)).toBe("src/lib/a.ts");
    expect(bundleSourcePath("_app/immutable/nodes/2.js", `${UP}src/routes/+page.svelte`)).toBe("src/routes/+page.svelte");
  });

  it("ignores dependencies, virtual ids and paths outside src/", () => {
    expect(bundleSourcePath(CHUNK, `${UP}node_modules/svelte/src/x.js`)).toBeNull();
    expect(bundleSourcePath(CHUNK, "\0virtual:x")).toBeNull();
    expect(bundleSourcePath(CHUNK, "vite/preload-helper.js")).toBeNull();
    expect(bundleSourcePath(CHUNK, `${UP}../outside/src/x.ts`)).toBeNull();
    expect(bundleSourcePath(CHUNK, "")).toBeNull();
  });
});

describe("chunkCoverage", () => {
  const segments = chunkSegments(CHUNK, code, map);

  it("attributes covered lines to each original file, honouring uncalled functions", () => {
    const files = chunkCoverage(segments, [top, aFn, bFn]);
    expect([...files.keys()].sort()).toEqual(["src/lib/a.ts", "src/lib/b.ts"]);
    // a() never ran: its whole line is inside a count-0 range.
    expect(files.get("src/lib/a.ts")).toMatchObject({ covered: [], mapped: [[1, 1]], ran: false, loaded: true });
    // b() ran (line 1) and the top-level call ran (line 3).
    expect(files.get("src/lib/b.ts")).toMatchObject({ covered: [[1, 1], [3, 3]], mapped: [[1, 1], [3, 3]], ran: true, loaded: true });
    expect(files.get("src/lib/b.ts")?.sourceText).toBe("b\n\nb()\n");
  });

  it("reports function spans only when asked", () => {
    expect(chunkCoverage(segments, [top, aFn, bFn]).get("src/lib/b.ts")?.blocks).toEqual([[1, 1]]);
    expect(chunkCoverage(segments, [top, aFn, bFn], { blocks: false }).get("src/lib/b.ts")?.blocks).toEqual([]);
  });

  it("marks nothing covered or loaded when the chunk never evaluated", () => {
    const files = chunkCoverage(segments, [fn(0, code.length, 0)]);
    expect(files.get("src/lib/b.ts")).toMatchObject({ covered: [], loaded: false });
    expect(chunkEvaluated([fn(0, code.length, 0)])).toBe(false);
    expect(chunkEvaluated([top])).toBe(true);
    expect(chunkEvaluated([])).toBe(true);
  });
});

describe("reduceCoverage with bundle chunks", () => {
  const segments = { ...chunkSegments(CHUNK, code, map), modules: ["src/lib/a.ts", "src/lib/b.ts", "src/lib/style.css"] };
  const url = `http://localhost:1420/${CHUNK}`;
  const read = (path: string) => (path === "src/lib/b.ts" ? Buffer.from("b\n\nb()\n") : Buffer.from("changed"));

  it("records loaded, exercised and line coverage per source file, plus unmapped chunk modules", () => {
    const seen = new Map();
    const result = reduceCoverage([{ url, functions: [top, aFn, bFn] as never }], { root: "/r", readFile: read, seen, chunk: (u) => (u === url ? segments : null) });
    expect(result.loaded).toEqual(["src/lib/a.ts", "src/lib/b.ts", "src/lib/style.css"]);
    expect(result.exercised).toEqual(["src/lib/b.ts"]);
    expect(result.lines).toEqual({ "src/lib/a.ts": [], "src/lib/b.ts": [[1, 1], [3, 3]] });
    // Metas once per chunk; b's embedded text matches the checkout, a's does not.
    expect(result.metas.map((m) => [m.path, m.aligned])).toEqual([["src/lib/a.ts", false], ["src/lib/b.ts", true]]);
    const again = reduceCoverage([{ url, functions: [top, bFn] as never }], { root: "/r", readFile: read, seen, chunk: () => segments });
    expect(again.metas).toEqual([]);
  });

  it("loads nothing from a chunk that did not evaluate", () => {
    const result = reduceCoverage([{ url, functions: [fn(0, code.length, 0)] as never }], { root: "/r", readFile: read, chunk: () => segments });
    expect(result.loaded).toEqual([]);
  });

  // #1391: a module tree-shaken out of every chunk has no code to cover, but
  // an edit can bring it into the bundle; every bundle test counts as loading it.
  it("counts tree-shaken modules as loaded by every test that evaluated the bundle", () => {
    const unbundled = ["src/lib/shaken.ts"];
    const ran = reduceCoverage([{ url, functions: [top, bFn] as never }], { root: "/r", readFile: read, chunk: () => segments, unbundled });
    expect(ran.loaded).toContain("src/lib/shaken.ts");
    expect(ran.exercised).not.toContain("src/lib/shaken.ts");
    const idle = reduceCoverage([{ url, functions: [fn(0, code.length, 0)] as never }], { root: "/r", readFile: read, chunk: () => segments, unbundled });
    expect(idle.loaded).toEqual([]);
    // Dev-server scripts are per module: their own coverage decides.
    const dev = reduceCoverage([{ url: "http://localhost:1421/src/lib/c.ts", functions: [top] as never }], { root: "/r", readFile: read, unbundled });
    expect(dev.loaded).toEqual(["src/lib/c.ts"]);
  });
});

describe("chunkModules", () => {
  it("lists each chunk's repository modules, without queries, dependencies or virtual ids", () => {
    const bundle = {
      "a.js": { type: "chunk", fileName: "_app/a.js", modules: {
        "/repo/src/lib/x.ts": {}, "/repo/src/lib/C.svelte?svelte&type=style&lang.css": {}, "/repo/src/lib/C.svelte": {},
        "/repo/node_modules/svelte/src/index.js": {}, "\0vite/preload-helper.js": {},
      } },
      "only-deps.js": { type: "chunk", fileName: "_app/d.js", modules: { "/repo/node_modules/x.js": {} } },
      "style.css": { type: "asset", fileName: "_app/s.css" },
    };
    expect(chunkModules(bundle, "/repo")).toEqual({ "_app/a.js": ["src/lib/C.svelte", "src/lib/x.ts"] });
  });
});

describe("unbundledModules", () => {
  it("lists src/ modules in the build graph that no chunk contains", () => {
    const chunks = { "_app/a.js": ["src/lib/C.svelte", "src/lib/x.ts"] };
    const ids = [
      "/repo/src/lib/x.ts", "/repo/src/lib/C.svelte?svelte&type=style&lang.css", "/repo/src/lib/C.svelte",
      "/repo/src/lib/shaken.ts", "/repo/src/lib/types.ts", "/repo/node_modules/svelte/src/index.js", "\0vite/preload-helper.js",
    ];
    expect(unbundledModules(ids, chunks, "/repo")).toEqual(["src/lib/shaken.ts", "src/lib/types.ts"]);
    expect(unbundledModules([], chunks, "/repo")).toEqual([]);
  });
});

describe("coverage origins (#1391)", () => {
  it("attributes a spec beside the bundle to its own dev server, not the project's", () => {
    expect(coverageOrigins({ projectBaseURL: "http://localhost:1420", specBaseURL: "http://localhost:1421/", bundled: true }))
      .toEqual({ requests: "http://localhost:1421", bundle: "http://localhost:1420", server: "dev" });
    expect(coverageOrigins({ projectBaseURL: "http://localhost:1420", specBaseURL: "http://localhost:1420/", bundled: true }))
      .toEqual({ requests: "http://localhost:1420", bundle: "http://localhost:1420", server: "bundle" });
  });

  it("is the dev server everywhere without a bundle", () => {
    expect(coverageOrigins({ projectBaseURL: "http://localhost:1420", bundled: false }))
      .toEqual({ requests: "http://localhost:1420", bundle: null, server: "dev" });
    expect(coverageOrigins({ bundled: true })).toEqual({ requests: null, bundle: null, server: "dev" });
    expect(coverageOrigins({ projectBaseURL: "not a url", bundled: true })).toEqual({ requests: null, bundle: null, server: "dev" });
  });
});

describe("map server kind (#1391)", () => {
  const record = (bundled?: boolean, server: "bundle" | "dev" = bundled ? "bundle" : "dev") =>
    ({ id: `t${bundled}`, spec: "e2e/a.spec.ts", loaded: [], exercised: [], server, ...(bundled === undefined ? {} : { bundled }) });

  it("is bundle only when every record came from a bundle run", () => {
    // A spec beside the bundle runs on the dev server in PR shards too.
    expect(mapServer([record(true), record(true, "dev")])).toEqual({ server: "bundle" });
    expect(mapServer([record(false)])).toEqual({ server: "dev" });
    expect(mergeImpact([record(true)], []).server).toBe("bundle");
  });

  // Review of #1391: a dev-push shard that lost the bundle artifact records
  // dev-server loader sets beside bundle ones; no PR shard matches that map.
  it("is mixed when a shard fell back to the dev server during a bundle run", () => {
    expect(mapServer([record(true), record(false)])).toEqual({ server: "mixed" });
  });

  it("is absent for records that predate the field", () => {
    expect(mapServer([record(true), record()])).toEqual({});
    expect(mapServer([])).toEqual({});
    expect("server" in mergeImpact([record()], [])).toBe(false);
  });
});

describe("impact map source", () => {
  const repo = "o/r";
  const run = (over: Record<string, unknown> = {}) => ({
    id: 1, event: "push", head_branch: "dev", path: ".github/workflows/ci.yml",
    repository: { full_name: repo }, head_repository: { full_name: repo }, ...over,
  });

  it("trusts only dev push/schedule/dispatch runs of the two producers in this repository", () => {
    expect(trustedProducer(run(), repo)).toBe(true);
    expect(trustedProducer(run({ event: "schedule", path: ".github/workflows/e2e-impact-map.yml" }), repo)).toBe(true);
    expect(trustedProducer(run({ event: "pull_request" }), repo)).toBe(false);
    expect(trustedProducer(run({ head_branch: "feature" }), repo)).toBe(false);
    expect(trustedProducer(run({ path: ".github/workflows/other.yml" }), repo)).toBe(false);
    expect(trustedProducer(run({ head_repository: { full_name: "fork/r" } }), repo)).toBe(false);
    expect(trustedProducer(run({ repository: { full_name: "fork/r" } }), repo)).toBe(false);
  });

  it("picks the newest unexpired artifact whose run is trusted", () => {
    const art = (id: number, runId: number, created: string, over: Record<string, unknown> = {}) => ({
      id, name: "e2e-impact-map", expired: false, created_at: created,
      workflow_run: { id: runId, head_branch: "dev", head_sha: `sha${id}` }, ...over,
    });
    const runs: Record<number, ReturnType<typeof run>> = {
      10: run({ id: 10, event: "pull_request" }), // forged by a PR whose branch is named dev
      11: run({ id: 11 }),
      12: run({ id: 12 }),
    };
    const artifacts = [
      art(1, 12, "2026-10-20T00:00:00Z"),
      art(2, 10, "2026-10-23T00:00:00Z"),
      art(3, 11, "2026-10-22T00:00:00Z"),
      art(4, 11, "2026-10-24T00:00:00Z", { expired: true }),
      art(5, 11, "2026-10-24T00:00:00Z", { name: "other" }),
    ];
    expect(pickMapArtifact(artifacts, (id) => runs[id] ?? null, repo)).toEqual({ artifact: 3, run: 11, sha: "sha3" });
    expect(pickMapArtifact([], () => null, repo)).toBeNull();
    expect(pickMapArtifact([art(2, 10, "2026-10-23T00:00:00Z")], (id) => runs[id] ?? null, repo)).toBeNull();
  });

  // #1391: shards serve the bundle, so a newer nightly dev-server map would
  // make every shard run in full; the newest ci.yml map wins over it.
  it("prefers the newest ci.yml map over a newer nightly one, falling back to the nightly", () => {
    const art = (id: number, runId: number, created: string) => ({
      id, name: "e2e-impact-map", expired: false, created_at: created,
      workflow_run: { id: runId, head_branch: "dev", head_sha: `sha${id}` },
    });
    const runs: Record<number, ReturnType<typeof run>> = {
      20: run({ id: 20, event: "schedule", path: ".github/workflows/e2e-impact-map.yml" }),
      21: run({ id: 21, path: ".github/workflows/ci.yml@refs/heads/dev" }),
    };
    const nightly = art(1, 20, "2026-10-25T00:00:00Z");
    const push = art(2, 21, "2026-10-24T00:00:00Z");
    expect(pickMapArtifact([nightly, push], (id) => runs[id] ?? null, repo)).toEqual({ artifact: 2, run: 21, sha: "sha2" });
    expect(pickMapArtifact([nightly], (id) => runs[id] ?? null, repo)).toEqual({ artifact: 1, run: 20, sha: "sha1" });
  });
});
