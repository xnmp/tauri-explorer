/** Row identity separate from file path (lineage peek H1): a path listed more
 * than once keeps one selection entry while the cursor, anchor and pruning
 * follow the occurrence. */
import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { PeekMeta } from "$lib/domain/folder-peek";
import { occurrenceKey, occurrencePath, parentKeyOf, peekKeyAt, resolvePeekCommandTarget, resolvePeekEscape } from "$lib/domain/folder-peek-flat";
import { lateRevealChain, prunePeekSelection } from "$lib/domain/folder-peek-pane";
import { resolveCursorIndex } from "$lib/domain/file-list-navigation";
import { calculateSelection, getSelectedEntries } from "$lib/state/selection";

const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, kind: "file", size: 0, modified: "2026-01-01T00:00:00Z" });
const A = file("/r/A"), B = file("/r/B"), m = file("/r/m"), c = file("/r/c");
// A ─ m ; B ─ m (the same file twice) ; c at depth 0.
const mUnderA = occurrenceKey("/r/A", "/r/m");
const mUnderB = occurrenceKey("/r/B", "/r/m");
const entries = [A, m, B, m, c];
const keys = ["/r/A", mUnderA, "/r/B", mUnderB, "/r/c"];
const meta = new Map<string, PeekMeta>([
  ["/r/A", { depth: 0, parentPath: "/r" }],
  [mUnderA, { depth: 1, parentPath: "/r", parentKey: "/r/A" }],
  ["/r/B", { depth: 0, parentPath: "/r" }],
  [mUnderB, { depth: 1, parentPath: "/r", parentKey: "/r/B" }],
  ["/r/c", { depth: 0, parentPath: "/r" }],
]);
const tree = { entries, keys, meta };

describe("occurrence keys", () => {
  it("name their own path or group id as the last segment", () => {
    expect(occurrencePath(mUnderA)).toBe("/r/m");
    expect(occurrencePath("/r/A")).toBe("/r/A");
    expect(occurrencePath(occurrenceKey(mUnderA, "group:/r/m|/r/x"))).toBe("group:/r/m|/r/x");
  });
  it("default to the path when a tree has no keys", () => {
    expect(peekKeyAt({ entries: [A, B] }, 1)).toBe("/r/B");
    expect(peekKeyAt(tree, 3)).toBe(mUnderB);
  });
  it("climb by parentKey, falling back to the folder", () => {
    expect(parentKeyOf(meta.get(mUnderB)!)).toBe("/r/B");
    expect(parentKeyOf(meta.get("/r/c")!)).toBe("/r");
  });
});

describe("resolveCursorIndex", () => {
  it("resolves the cursor's own occurrence of a repeated path", () => {
    expect(resolveCursorIndex(entries, keys, "/r/m", mUnderB, new Set())).toBe(3);
    expect(resolveCursorIndex(entries, keys, "/r/m", mUnderA, new Set())).toBe(1);
  });
  it("ignores a key that names another path, using the first occurrence", () => {
    expect(resolveCursorIndex(entries, keys, "/r/m", "/r/c", new Set())).toBe(1);
    expect(resolveCursorIndex(entries, keys, "/r/m", occurrenceKey("/r/gone", "/r/m"), new Set())).toBe(1);
  });
  it("falls back to the selection, then the first entry, then -1", () => {
    expect(resolveCursorIndex(entries, keys, "/r/missing", null, new Set(["/r/c"]))).toBe(4);
    expect(resolveCursorIndex(entries, keys, null, null, new Set())).toBe(0);
    expect(resolveCursorIndex([], undefined, null, null, new Set())).toBe(-1);
  });
});

describe("selection over repeated paths", () => {
  it("a Shift range runs between the anchor and clicked occurrences, holding each path once", () => {
    // Anchor on c (index 4), shift-click m under B (index 3): only B's m and c.
    const result = calculateSelection(entries, m, new Set(["/r/c"]), "/r/c", { shiftKey: true }, { clicked: 3, anchor: 4 });
    expect([...result.selectedPaths].sort()).toEqual(["/r/c", "/r/m"]);
    // From the first occurrence the range spans A's m through c, including B.
    const wide = calculateSelection(entries, m, new Set(["/r/c"]), "/r/c", { shiftKey: true }, { clicked: 1, anchor: 4 });
    expect([...wide.selectedPaths].sort()).toEqual(["/r/B", "/r/c", "/r/m"]);
  });
  it("a stale occurrence index falls back to the path's first occurrence", () => {
    const result = calculateSelection(entries, m, new Set(), "/r/A", { shiftKey: true }, { clicked: 4, anchor: 0 });
    expect([...result.selectedPaths].sort()).toEqual(["/r/A", "/r/m"]);
  });
  it("file operations receive each selected path once", () => {
    expect(getSelectedEntries(entries, new Set(["/r/m", "/r/c"]))).toEqual([m, c]);
  });
});

describe("prunePeekSelection with repeated paths", () => {
  it("keeps a path selected while any occurrence stays visible", () => {
    // B collapses: its m hides, A's m stays.
    expect(prunePeekSelection(tree, [A, m, B, c], ["/r/m"], "/r/m", "/r/m", mUnderB, mUnderB)).toBeNull();
  });
  it("hides a path whose every occurrence left, refocusing the cursor's own parent", () => {
    const result = prunePeekSelection(tree, [A, B, c], ["/r/m", "/r/c"], "/r/m", null, mUnderB, null);
    expect(result).toEqual({ selected: ["/r/c"], refocus: "/r/B" });
  });
});

describe("peek commands from an occurrence", () => {
  it("name the occurrence's own parent", () => {
    expect(resolvePeekEscape(m, meta, mUnderB)).toBe("/r/B");
    expect(resolvePeekEscape(m, meta, mUnderA)).toBe("/r/A");
    expect(resolvePeekCommandTarget(m, meta, "tree", mUnderB)).toBe("/r/B");
  });
  it("toggle a peekable file itself", () => {
    expect(resolvePeekCommandTarget(A, meta, "tree", "/r/A", entry => entry.path === "/r/A")).toBe("/r/A");
    expect(resolvePeekCommandTarget(c, meta, "tree", "/r/c")).toBeNull();
  });
});

describe("lateRevealChain (#1443)", () => {
  // m was revealed before the lineage landed, so it was selected at depth 0.
  const flat = { entries: [A, B, c, m], meta: new Map<string, PeekMeta>() };
  const chainOfM = ["/r/A", "group:/r/A|/r/B"];
  const grouping = { revealChain: (path: string) => path === "/r/m" ? chainOfM : [] };

  it("opens the revealed file's chain when grouping moves it under a closed parent", () => {
    expect(lateRevealChain(flat, [A, B, c], "/r/m", grouping)).toEqual(chainOfM);
  });
  it("also from a peek tree where the file sat at depth 0", () => {
    const before = { entries: [A, c, m], keys: ["/r/A", "/r/c", "/r/m"], meta: new Map<string, PeekMeta>([
      ["/r/A", { depth: 0, parentPath: "/r" }], ["/r/c", { depth: 0, parentPath: "/r" }], ["/r/m", { depth: 0, parentPath: "/r" }],
    ]) };
    expect(lateRevealChain(before, [A, c], "/r/m", grouping)).toEqual(chainOfM);
  });
  it("leaves a user collapse alone: the file hid from inside a peek", () => {
    // B collapses and A collapses, hiding both occurrences of the revealed m.
    expect(lateRevealChain(tree, [A, B, c], "/r/m", grouping)).toEqual([]);
  });
  it("does nothing while the file stays visible, without a reveal, or without grouping", () => {
    expect(lateRevealChain(flat, [A, m, B, c], "/r/m", grouping)).toEqual([]);
    expect(lateRevealChain(flat, [A, B, c], null, grouping)).toEqual([]);
    expect(lateRevealChain(flat, [A, B, c], "/r/m", null)).toEqual([]);
  });
  it("does nothing for a revealed file that was not shown before, or that no parent groups", () => {
    expect(lateRevealChain({ entries: [A, B, c], meta: new Map() }, [A, B], "/r/m", grouping)).toEqual([]);
    expect(lateRevealChain(flat, [A, B, m], "/r/c", grouping)).toEqual([]);
  });
});
