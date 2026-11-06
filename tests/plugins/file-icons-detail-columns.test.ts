/**
 * Plugin file icons and Details columns through the plugin context (#1523):
 * registration, ownership, lazy loading, failure isolation and disposal.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "$lib/plugins/api";
import { fileIconRegistry } from "$lib/plugins/file-icon-registry.svelte";
import { detailColumnRegistry } from "$lib/plugins/detail-column-registry.svelte";
import type { FileEntry } from "$lib/domain/file";

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='8'/></svg>";
const file = (name: string, size = 1, modified = "2026-01-01T00:00:00Z"): FileEntry => ({ name, path: `/r/${name}`, kind: "file", size, modified });
const dir = (name: string): FileEntry => ({ name, path: `/r/${name}`, kind: "directory", size: 0, modified: "" });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// Registration validates in a lazily loaded module; load it once up front so
// each test's settle() measures registration, not a cold module transform.
beforeAll(async () => { await import("$lib/plugins/register-contributions"); });

const disposers: (() => void)[] = [];
function plugin(id: string) {
  const handle = createPluginContext(id);
  disposers.push(handle.dispose);
  return handle;
}
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

describe("registerFileIcon (#1523)", () => {
  it("gives matching files the plugin icon and type name, never folders, until deactivation", async () => {
    const { ctx, dispose } = plugin("bw");
    ctx.registerFileIcon!({ id: "bw.rep", extensions: ["rep"], svg: SVG, typeName: "StarCraft replay" });
    await settle();

    expect(fileIconRegistry.forEntry(file("game.REP"))?.typeName).toBe("StarCraft replay");
    expect(fileIconRegistry.forEntry(file("game.rep"))?.src).toMatch(/^data:image\/svg\+xml/);
    expect(fileIconRegistry.forEntry(dir("replays.rep"))).toBeUndefined();
    expect(fileIconRegistry.forEntry(file("notes.txt"))).toBeUndefined();

    dispose();
    expect(fileIconRegistry.forEntry(file("game.rep"))).toBeUndefined();
  });

  it("lets the first plugin keep an extension and hands it over when that plugin leaves", async () => {
    const first = plugin("alpha");
    const second = plugin("beta");
    first.ctx.registerFileIcon!({ id: "alpha.icon", extensions: ["rep"], svg: SVG, typeName: "Alpha" });
    second.ctx.registerFileIcon!({ id: "beta.icon", extensions: ["rep"], svg: SVG, typeName: "Beta" });
    await settle();
    expect(fileIconRegistry.forEntry(file("a.rep"))?.typeName).toBe("Alpha");
    first.dispose();
    expect(fileIconRegistry.forEntry(file("a.rep"))?.typeName).toBe("Beta");
  });

  it("refuses another plugin's id synchronously and reports invalid artwork without registering", async () => {
    const { ctx } = plugin("gamma");
    expect(() => ctx.registerFileIcon!({ id: "alpha.icon", extensions: ["x"], svg: SVG })).toThrow(/must be named gamma\.<name>/);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.registerFileIcon!({ id: "gamma.bad", extensions: ["x"], svg: "<img src=x>" });
    await settle();
    expect(fileIconRegistry.forEntry(file("a.x"))).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("never registers an icon whose plugin deactivated before validation loaded", async () => {
    const { ctx, dispose } = plugin("delta");
    ctx.registerFileIcon!({ id: "delta.icon", extensions: ["late"], svg: SVG });
    dispose();
    await settle();
    expect(fileIconRegistry.forEntry(file("a.late"))).toBeUndefined();
  });
});

describe("registerDetailColumns (#1523)", () => {
  const columns = [{ key: "matchup", label: "Matchup", width: 90 }, { key: "map", label: "Map" }];
  const isRep = (entry: FileEntry) => entry.kind === "file" && entry.name.endsWith(".rep");

  it("offers columns only while a listed entry applies, and loads values for requested rows", async () => {
    const load = vi.fn(async (entries: readonly FileEntry[]) => entries.map((entry) => ({ columns: { matchup: `M:${entry.name}`, map: "Python" }, lengthSeconds: 600 })));
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.header", columns, applies: isRep, load });
    await settle();

    expect(detailColumnRegistry.columnsFor([file("a.txt"), dir("b.rep")])).toEqual([]);
    const offered = detailColumnRegistry.columnsFor([file("a.txt"), file("g.rep")]);
    expect(offered.map((column) => column.id)).toEqual(["bw.header:matchup", "bw.header:map"]);

    const game = file("g.rep");
    detailColumnRegistry.request(game, offered, false);
    detailColumnRegistry.request(file("a.txt"), offered, false);
    expect(detailColumnRegistry.text(game, offered[0])).toBeUndefined();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0].map((entry) => entry.name)).toEqual(["g.rep"]);
    expect(detailColumnRegistry.text(game, offered[0])).toBe("M:g.rep");
    expect(detailColumnRegistry.text(game, offered[1])).toBe("Python");
    expect(detailColumnRegistry.lengthSeconds(game)).toBe(600);
  });

  it("reloads a rewritten file but not an unchanged one", async () => {
    let calls = 0;
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.header", columns, applies: isRep,
      load: async (entries) => entries.map(() => ({ columns: { matchup: `v${++calls}` } })) });
    await settle();
    const [matchup] = detailColumnRegistry.columnsFor([file("g.rep")]);
    detailColumnRegistry.request(file("g.rep"), [], true);
    await settle();
    detailColumnRegistry.request(file("g.rep"), [], true);
    await settle();
    expect(detailColumnRegistry.text(file("g.rep"), matchup)).toBe("v1");
    const rewritten = file("g.rep", 2, "2026-02-01T00:00:00Z");
    expect(detailColumnRegistry.text(rewritten, matchup)).toBeUndefined();
    detailColumnRegistry.request(rewritten, [], true);
    await settle();
    expect(detailColumnRegistry.text(rewritten, matchup)).toBe("v2");
  });

  it("isolates a failing provider: empty cells, one report, no throw into rendering", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.header", columns, applies: isRep, load: async () => { throw new Error("backend down"); } });
    await settle();
    const [matchup] = detailColumnRegistry.columnsFor([file("g.rep")]);
    detailColumnRegistry.request(file("g.rep"), [], true);
    detailColumnRegistry.request(file("h.rep", 3), [], true);
    await settle();
    expect(detailColumnRegistry.text(file("g.rep"), matchup)).toBeUndefined();
    expect(error.mock.calls.filter(([message]) => String(message).includes("detail columns bw.header"))).toHaveLength(1);
    error.mockRestore();
  });

  it("treats a throwing applies() as not applying", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.header", columns, applies: () => { throw new Error("boom"); }, load: async () => [] });
    await settle();
    expect(detailColumnRegistry.columnsFor([file("g.rep")])).toEqual([]);
    error.mockRestore();
  });

  it("normalizes a malformed load result instead of rendering it", async () => {
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.header", columns, applies: isRep,
      load: async () => [{ columns: { matchup: { html: "<b>" } }, lengthSeconds: Number.NaN }] as never });
    await settle();
    const [matchup] = detailColumnRegistry.columnsFor([file("g.rep")]);
    detailColumnRegistry.request(file("g.rep"), [], true);
    await settle();
    expect(detailColumnRegistry.text(file("g.rep"), matchup)).toBeUndefined();
    expect(detailColumnRegistry.lengthSeconds(file("g.rep"))).toBeUndefined();
  });

  it("aborts in-flight loads on deactivation and forgets its columns", async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const { ctx, dispose } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.header", columns, applies: isRep, load: (entries, s) => {
      signal = s;
      return new Promise((resolve) => { release = () => resolve(entries.map(() => ({ columns: { matchup: "late" } }))); });
    } });
    await settle();
    const [matchup] = detailColumnRegistry.columnsFor([file("g.rep")]);
    detailColumnRegistry.request(file("g.rep"), [], true);
    await settle();
    dispose();
    expect(signal?.aborted).toBe(true);
    release();
    await settle();
    expect(detailColumnRegistry.columnsFor([file("g.rep")])).toEqual([]);
    expect(detailColumnRegistry.text(file("g.rep"), matchup)).toBeUndefined();
  });

  it("rejects providers without functions and invalid columns without registering", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.nofns", columns } as never);
    ctx.registerDetailColumns!({ id: "bw.badcols", columns: [{ key: "Bad Key", label: "x" }], applies: isRep, load: async () => [] });
    await settle();
    expect(detailColumnRegistry.columnsFor([file("g.rep")])).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe("detail column request gating and identity (#1523 review)", () => {
  const isRep = (entry: FileEntry) => entry.kind === "file" && entry.name.endsWith(".rep");
  it("loads a provider for a row only while one of its columns or Length is shown", async () => {
    const loadA = vi.fn(async (entries: readonly FileEntry[]) => entries.map(() => ({ columns: { a: "A" } })));
    const loadB = vi.fn(async (entries: readonly FileEntry[]) => entries.map(() => ({ columns: { b: "B" } })));
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.a", columns: [{ key: "a", label: "A" }], applies: isRep, load: loadA });
    ctx.registerDetailColumns!({ id: "bw.b", columns: [{ key: "b", label: "B" }], applies: isRep, load: loadB });
    await settle();
    const [columnA] = detailColumnRegistry.columnsFor([file("g.rep")]);
    detailColumnRegistry.request(file("g.rep"), [columnA], false);
    await settle();
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).not.toHaveBeenCalled();
    detailColumnRegistry.request(file("g.rep"), [columnA], true);
    await settle();
    expect(loadB).toHaveBeenCalledTimes(1);
  });

  it("returns the same column array while the offering providers are unchanged", async () => {
    const { ctx } = plugin("bw");
    ctx.registerDetailColumns!({ id: "bw.a", columns: [{ key: "a", label: "A" }], applies: isRep, load: async () => [] });
    await settle();
    const first = detailColumnRegistry.columnsFor([file("g.rep")]);
    expect(detailColumnRegistry.columnsFor([file("x.txt"), file("h.rep")])).toBe(first);
    expect(detailColumnRegistry.columnsFor([file("x.txt")])).toEqual([]);
  });
});

describe("BatchedEntryResolver robustness (#1523 review)", () => {
  it("settles a batch whose item normalization throws, so the row can load again", async () => {
    const { BatchedEntryResolver } = await import("$lib/state/batched-entry-resolver.svelte");
    let calls = 0;
    const resolver = new BatchedEntryResolver<string | null>({
      load: async (entries) => { calls += 1; return entries.map(() => ({})); },
      normalize: () => { if (calls === 1) throw new Error("hostile getter"); return "ok"; },
      failure: null,
    });
    const entry = file("g.rep");
    resolver.request(entry);
    await settle();
    expect(resolver.value(entry)).toBeNull();
    // A settled failure is cached like any other unreadable value; a new revision reloads.
    const rewritten = file("g.rep", 2, "2026-03-01T00:00:00Z");
    resolver.request(rewritten);
    await settle();
    expect(calls).toBe(2);
    expect(resolver.value(rewritten)).toBe("ok");
  });
});
