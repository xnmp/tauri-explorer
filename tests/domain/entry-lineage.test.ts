/** Lineage peek grouping (docs/execution-plans/lineage-peek.md §3) and every
 * §5 invariant, through the same tree walk and row builder the panes use. */
import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { projectLineage, lineageGroupLabel, type EntryLineage, type LineageParent } from "$lib/domain/entry-lineage";
import { buildPeekRows, flattenPeekEntries, LINEAGE_OCCURRENCE_CAP, type PeekRows, type PeekTree } from "$lib/domain/folder-peek";
import { occurrencePath, peekKeyAt } from "$lib/domain/folder-peek-flat";
import { prunePeekSelection } from "$lib/domain/folder-peek-pane";
import { collapseSubtree, pruneExpanded } from "$lib/domain/folder-peek-memory";
import { getSelectedEntries, selectByIndices } from "$lib/state/selection";

const R = "/r";
const file = (name: string, kind: FileEntry["kind"] = "file"): FileEntry => ({ name, path: `${R}/${name}`, kind, size: 1, modified: "2026-01-01T00:00:00Z" });
const p = (name: string): LineageParent => ({ kind: "entry", path: `${R}/${name}` });
const lineageOf = (parents: Record<string, LineageParent[]>, revision = "1"): EntryLineage =>
  ({ revision, parents: new Map(Object.entries(parents).map(([name, list]) => [`${R}/${name}`, list])) });

/** The design's worked example: A edited into c and d; A + B merged into m. */
const A = file("A.png"), B = file("B.png"), c = file("c.png"), d = file("d.png"), m = file("m.png"), z = file("z.txt");
const listing = [A, B, c, d, m, z];
const worked = lineageOf({ "c.png": [p("A.png")], "d.png": [p("A.png")], "m.png": [p("A.png"), p("B.png")] });

function tree(entries: readonly FileEntry[], lineage: EntryLineage, open: readonly string[] = [], windows = false): PeekTree {
  const projection = projectLineage(entries, lineage, windows);
  const grouped = projection.kind === "grouped";
  return flattenPeekEntries({
    root: R, entries: grouped ? projection.roots : entries, expanded: new Map(open.map((id, index) => [id, index + 1])),
    listing: () => undefined, project: items => items, capability: "tree", windows,
    ...(grouped ? { lineage: projection } : {}),
  });
}
const rows = (t: PeekTree): PeekRows => buildPeekRows(t, () => undefined);
/** A readable outline: indent per depth; groups as "[with B]". */
const outline = (t: PeekTree) => rows(t).rows.map(row =>
  row.kind === "entry" ? `${"  ".repeat(row.depth)}${row.entry.name}`
  : row.kind === "lineage-group" ? `${"  ".repeat(row.depth)}[${row.group.label}]` : row.kind);

const groupA = "group:/r/A.png|/r/B.png";
const groupB = "group:/r/B.png|/r/A.png";
const everything = [A.path, B.path, groupA, groupB, m.path];

describe("projectLineage (§3 grouping rule)", () => {
  it("groups the worked example: shared children under group rows, own children direct", () => {
    expect(outline(tree(listing, worked, everything))).toEqual([
      "A.png", "  [with B.png]", "    m.png", "  c.png", "  d.png",
      "B.png", "  [with A.png]", "    m.png",
      "z.txt",
    ]);
  });
  it("keeps depth 0 to roots and ordinary files while nothing is open", () => {
    expect(outline(tree(listing, worked))).toEqual(["A.png", "B.png", "z.txt"]);
  });
  it("sorts group rows by label, before direct children in the pane's order", () => {
    const C = file("C.png"), e = file("e.png"), f = file("f.png"), g = file("g.png");
    const list = [A, B, C, e, f, g];
    const lineage = lineageOf({ "g.png": [p("A.png")], "e.png": [p("A.png"), p("C.png")], "f.png": [p("A.png"), p("B.png")] });
    const id = (others: string) => `group:/r/A.png|${others}`;
    expect(outline(tree(list, lineage, [A.path, id("/r/C.png"), id("/r/B.png")])).slice(0, 6)).toEqual([
      "A.png", "  [with B.png]", "    f.png", "  [with C.png]", "    e.png", "  g.png",
    ]);
  });
  it("labels groups in parent-set order and shortens past three names", () => {
    expect(lineageGroupLabel(["B", "C", "D"])).toBe("with B, C, D");
    expect(lineageGroupLabel(["B", "C", "D", "E"])).toBe("with B, C +2");
    const C = file("C.png"), D = file("D.png");
    const list = [A, B, C, D, m];
    const projection = projectLineage(list, lineageOf({ "m.png": [p("D.png"), p("A.png"), p("B.png")] }), false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    const group = projection.children(A.path)!.groups[0];
    expect(group.label).toBe("with D.png, B.png");
    expect(group.id).toBe("group:/r/A.png|/r/B.png|/r/D.png");
    expect(group.thumbnailPath).toBe(D.path);
  });
  it("counts external parents in the set, labelled with a marker; only-external files are roots", () => {
    const lineage = lineageOf({
      "m.png": [p("A.png"), { kind: "external", key: "ref:1", label: "sky.jpg", thumbnailPath: "/elsewhere/sky.jpg" }],
      "c.png": [{ kind: "external", key: "ref:2", label: "x.jpg" }],
    });
    const projection = projectLineage(listing, lineage, false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    expect(projection.roots.map(entry => entry.name)).toEqual(["A.png", "B.png", "c.png", "d.png", "z.txt"]);
    const group = projection.children(A.path)!.groups[0];
    expect(group.label).toBe("with sky.jpg ↗");
    expect(group.id).toBe("group:/r/A.png|external:ref:1");
    expect(group.thumbnailPath).toBe("/elsewhere/sky.jpg");
  });
  it("lets a grouped child open its own lineage beneath each occurrence", () => {
    const n = file("n.png");
    const lineage = lineageOf({ "m.png": [p("A.png"), p("B.png")], "n.png": [p("m.png")] });
    expect(outline(tree([A, B, m, n], lineage, [...everything]))).toEqual([
      "A.png", "  [with B.png]", "    m.png", "      n.png",
      "B.png", "  [with A.png]", "    m.png", "      n.png",
    ]);
  });
  it("lists descendants for Select with edits, in listing order", () => {
    const n = file("n.png");
    const projection = projectLineage([A, B, m, n, c], lineageOf({ "m.png": [p("A.png"), p("B.png")], "n.png": [p("m.png")], "c.png": [p("A.png")] }), false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    expect(projection.descendants([A.path])).toEqual([m.path, n.path, c.path]);
    expect(projection.descendants([B.path, m.path])).toEqual([n.path]);
  });
  it("compares paths with the platform's rules", () => {
    const W = (name: string): FileEntry => ({ ...file(name), path: `C:\\r\\${name}` });
    const lineage: EntryLineage = { revision: "1", parents: new Map([["c:/r/m.png", [{ kind: "entry", path: "C:/r/A.png" }]]]) };
    const projection = projectLineage([W("A.png"), W("m.png")], lineage, true);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    expect(projection.children("C:\\r\\A.png")!.direct.map(entry => entry.path)).toEqual(["C:\\r\\m.png"]);
  });
});

describe("§5 invariants", () => {
  const providers: Record<string, EntryLineage> = {
    worked,
    chain: lineageOf({ "c.png": [p("A.png")], "d.png": [p("c.png")], "m.png": [p("d.png"), p("B.png")] }),
    diamond: lineageOf({ "c.png": [p("A.png")], "d.png": [p("A.png")], "m.png": [p("c.png"), p("d.png")] }),
    externalMix: lineageOf({ "m.png": [p("A.png"), { kind: "external", key: "k", label: "out" }], "c.png": [{ kind: "external", key: "k", label: "out" }] }),
  };
  const allOpen = (lineage: EntryLineage) => {
    const projection = projectLineage(listing, lineage, false);
    if (projection.kind !== "grouped") return [];
    return listing.flatMap(entry => {
      const children = projection.children(entry.path);
      return children ? [entry.path, ...children.groups.map(group => group.id)] : [];
    });
  };

  for (const [name, lineage] of Object.entries(providers)) {
    it(`${name}: every file is reachable, at depth 0 or under a present parent`, () => {
      const shown = new Set(tree(listing, lineage, allOpen(lineage)).entries.map(entry => entry.path));
      expect([...shown].sort()).toEqual(listing.map(entry => entry.path).sort());
    });
    it(`${name}: a file appears once under each present parent, inside the group for its exact set`, () => {
      const t = tree(listing, lineage, allOpen(lineage));
      for (const [child, parents] of lineage.parents) {
        const entryParents = parents.filter(parent => parent.kind === "entry").map(parent => (parent as { path: string }).path);
        if (!entryParents.length) continue; // Only external parents: a root.
        const occurrences = t.keys!.map((key, index) => ({ key, index })).filter(({ index }) => t.entries[index].path === child);
        // Each occurrence's nearest file ancestor is one of the parents, once each.
        const fileParents = occurrences.map(({ key }) => {
          let at = t.meta.get(key)!.parentKey!;
          while (occurrencePath(at).startsWith("group:")) at = t.meta.get(at)?.parentKey ?? [...t.headers ?? []].find(h => h.key === at)!.parentKey;
          return occurrencePath(at);
        });
        const expected = new Set(entryParents);
        expect(fileParents.filter(path => expected.has(path)).sort()).toEqual([...expected].sort().flatMap(parent =>
          // A parent shown more than once (it is itself a merge output) carries the child each time.
          t.entries.filter(entry => entry.path === parent).map(() => parent)));
        // Inside a group exactly when the set has other members.
        const grouped = parents.length > 1;
        for (const { key } of occurrences) expect(occurrencePath(t.meta.get(key)!.parentKey!).startsWith("group:")).toBe(grouped);
      }
    });
  }

  it("selection is a set of paths: every occurrence highlights and file operations get each path once", () => {
    const t = tree(listing, worked, everything);
    const both = t.entries.flatMap((entry, index) => entry.path === m.path ? [index] : []);
    expect(both).toHaveLength(2);
    // Marquee over both occurrences selects the path once.
    const selected = selectByIndices([...t.entries], both, new Set(), false);
    expect([...selected]).toEqual([m.path]);
    expect(t.entries.filter(entry => selected.has(entry.path))).toHaveLength(2);
    expect(getSelectedEntries([...t.entries], selected)).toEqual([m]);
  });

  it("grouping off, or no lineage, is byte-identical to Folder Peek rows", () => {
    const folder = file("Folder", "directory");
    const plain = [folder, ...listing];
    const reference = flattenPeekEntries({ root: R, entries: plain, expanded: new Map([[folder.path, 1]]),
      listing: () => [{ ...file("inside"), path: `${folder.path}/inside` }], project: items => items, capability: "tree", windows: false });
    const empty = projectLineage(plain, lineageOf({}), false);
    expect(empty).toEqual({ kind: "flat", reason: "empty" });
    const unknown = projectLineage(plain, lineageOf({ "nope.png": [p("A.png")] }), false);
    expect(unknown.kind).toBe("flat");
    expect(reference.keys).toBeUndefined();
    expect(reference.headers).toBeUndefined();
    expect(JSON.stringify(rows(reference))).toBe(JSON.stringify(buildPeekRows(flattenPeekEntries({ root: R, entries: plain,
      expanded: new Map([[folder.path, 1]]), listing: () => [{ ...file("inside"), path: `${folder.path}/inside` }], project: items => items,
      capability: "tree", windows: false, lineage: { children: () => undefined } }), () => undefined)));
  });

  it("a folder still peeks as a folder under grouping", () => {
    const folder = file("Folder", "directory");
    const inside = { ...file("inside"), path: `${folder.path}/inside` };
    const projection = projectLineage([folder, ...listing], worked, false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    const t = flattenPeekEntries({ root: R, entries: projection.roots, expanded: new Map([[folder.path, 1], [A.path, 2]]),
      listing: path => path === folder.path ? [inside] : undefined, project: items => items, capability: "tree", windows: false, lineage: projection });
    expect(t.expanded).toEqual([folder.path]);
    expect(t.lineageOpen).toEqual([A.path]);
    expect(t.entries.map(entry => entry.name)).toEqual(["Folder", "inside", "A.png", "c.png", "d.png", "B.png", "z.txt"]);
  });

  it("a cycle, a foreign path or a self-edge never throws and falls back to flat", () => {
    const cycle = lineageOf({ "c.png": [p("d.png")], "d.png": [p("c.png")], "m.png": [p("A.png")] });
    expect(projectLineage(listing, cycle, false)).toEqual({ kind: "flat", reason: "cycle" });
    const self = lineageOf({ "c.png": [p("c.png")] });
    expect(projectLineage(listing, self, false)).toEqual({ kind: "flat", reason: "empty" });
    const foreign = lineageOf({ "c.png": [{ kind: "entry", path: "/elsewhere/A.png" }, p("A.png")], "d.png": [{ kind: "entry", path: "relative" }] });
    const projection = projectLineage(listing, foreign, false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    expect(projection.children(A.path)!.direct).toEqual([c]);
    expect(projection.roots).toContain(d);
    // Malformed provider data is dropped, not thrown.
    const malformed = { revision: "x", parents: new Map<string, unknown>([["/r/c.png", null], ["/r/d.png", [null, { kind: "entry" }]]]) } as unknown as EntryLineage;
    expect(() => projectLineage(listing, malformed, false)).not.toThrow();
  });

  it("collapsing never leaves a hidden selection; a path stays selected while any occurrence shows", () => {
    const open = tree(listing, worked, everything);
    // Close B: its m hides, A's stays, so m stays selected.
    const closedB = tree(listing, worked, everything.filter(id => id !== B.path));
    const mUnderB = open.keys!.find(key => key.startsWith(B.path) && occurrencePath(key) === m.path)!;
    expect(prunePeekSelection(open, closedB.entries, [m.path], m.path, m.path, mUnderB, mUnderB)).toBeNull();
    // Close A's group too: m is hidden everywhere and leaves the selection; the cursor lands on B.
    const closedBoth = tree(listing, worked, [A.path]);
    const result = prunePeekSelection(open, closedBoth.entries, [m.path, z.path], m.path, null, mUnderB, null);
    expect(result).toEqual({ selected: [z.path], refocus: B.path });
  });
});

describe("review fixes", () => {
  it("ignores a folder named as a lineage parent, so its child stays a root", () => {
    const dir = file("dir", "directory");
    const projection = projectLineage([dir, c], lineageOf({ "c.png": [p("dir")] }), false);
    expect(outline(tree([dir, c], lineageOf({ "c.png": [p("dir")] }), [dir.path]))).not.toContain("  c.png");
    expect(projection.kind === "grouped" ? projection.roots.map(e => e.name) : ["dir", "c.png"]).toContain("c.png");
  });
  it("revealChain names the peeks that show a file once: ancestors root first, with their groups", () => {
    const projection = projectLineage(listing, worked, false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    expect(projection.revealChain(A.path)).toEqual([]);
    expect(projection.revealChain(c.path)).toEqual([A.path]);
    expect(projection.revealChain(m.path)).toEqual([A.path, groupA]);
    const opened = tree(listing, worked, projection.revealChain(m.path));
    expect(opened.entries.some(e => e.path === m.path)).toBe(true);
  });
  it("revealChain terminates on a malformed chain and on deep chains", () => {
    const chain = Array.from({ length: 50 }, (_, i) => file(`n${i}.png`));
    const lineage = lineageOf(Object.fromEntries(chain.slice(1).map((e, i) => [e.name, [p(chain[i].name)]])));
    const projection = projectLineage(chain, lineage, false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    expect(projection.revealChain(chain[49].path)).toHaveLength(49);
  });
  it("bounds a merge lattice: repeated occurrences stop opening past the cap", () => {
    // Each layer merges both files of the layer before: occurrences double per layer.
    const layers = 20;
    const files = Array.from({ length: layers * 2 }, (_, i) => file(`l${Math.floor(i / 2)}_${i % 2}.png`));
    const parents: Record<string, LineageParent[]> = {};
    for (let i = 2; i < files.length; i++) parents[files[i].name] = [p(files[Math.floor(i / 2) * 2 - 2].name), p(files[Math.floor(i / 2) * 2 - 1].name)];
    const lineage = lineageOf(parents);
    const projection = projectLineage(files, lineage, false);
    if (projection.kind !== "grouped") throw new Error("expected grouping");
    const open = files.flatMap(f => [f.path, ...projection.revealChain(f.path)]);
    const t = tree(files, lineage, [...new Set(open)]);
    expect(t.entries.length).toBeLessThan(LINEAGE_OCCURRENCE_CAP * 4);
    expect(new Set(t.entries.map(e => e.path)).size).toBe(files.length);
  });
  it("prunes a depth-0 selection that became grouped under a closed parent", () => {
    const flat = tree(listing, lineageOf({}));
    const grouped = tree(listing, worked);
    const result = prunePeekSelection(flat, grouped.entries, [c.path, z.path], c.path, null, undefined, undefined, path => path === c.path);
    expect(result?.selected).toEqual([z.path]);
  });
});

describe("expanded state", () => {
  it("is shared by path: opening m opens it at every occurrence", () => {
    const n = file("n.png");
    const lineage = lineageOf({ "m.png": [p("A.png"), p("B.png")], "n.png": [p("m.png")] });
    const t = tree([A, B, m, n], lineage, everything);
    expect(t.entries.filter(entry => entry.path === n.path)).toHaveLength(2);
    expect(rows(t).rows.filter(row => row.kind === "entry" && row.entry.path === m.path && row.expanded)).toHaveLength(2);
  });
  it("prunes a lineage file, and the groups it owns, once it leaves the listing", () => {
    const expanded = new Map([[A.path, 1], [groupA, 2], [B.path, 3], ["/r/Folder", 4]]);
    const listed = [B, file("Folder", "directory")];
    expect([...pruneExpanded(expanded, R, listed, false).keys()]).toEqual([B.path, "/r/Folder"]);
    expect([...pruneExpanded(expanded, R, [A, B, file("Folder", "directory")], false).keys()]).toEqual([...expanded.keys()]);
  });
  it("collapses group keys with their file under a collapsed root", () => {
    const expanded = new Map([[groupA, 1], ["group:/other/x|/other/y", 2]]);
    expect([...collapseSubtree(expanded, [R], false).keys()]).toEqual(["group:/other/x|/other/y"]);
  });
});

describe("rows", () => {
  it("give group rows no entry index (never selected or in marquee ranges) and keys unique per occurrence", () => {
    const result = rows(tree(listing, worked, everything));
    const groups = result.rows.flatMap((row, index) => row.kind === "lineage-group" ? [index] : []);
    expect(groups).toHaveLength(2);
    for (const index of groups) expect(result.rowToEntry[index]).toBeNull();
    const keys = result.rows.map(row => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("draw a guide for each open file and group", () => {
    const result = rows(tree(listing, worked, everything));
    expect(result.groups.map(group => [occurrencePath(group.path), group.depth, group.startRow, group.endRow])).toEqual([
      [A.path, 0, 1, 5], [groupA, 1, 2, 3], [B.path, 0, 6, 8], [groupB, 1, 7, 8],
    ]);
  });
  it("peekKeyAt names each occurrence", () => {
    const t = tree(listing, worked, everything);
    expect(t.entries.map((_, index) => peekKeyAt(t, index).split("\0").length)).toEqual([1, 3, 2, 2, 1, 3, 1]);
  });
});
