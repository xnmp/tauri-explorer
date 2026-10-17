import { describe, expect, it } from "vitest";
import { columnFlow, listRows, listPageColumns, resolveListMove, listColumnRange, listWheelDelta, type SlotSpec } from "$lib/domain/list-column-flow";

const plain = () => ({ slots: 1, card: false });
const items = (n: number) => Array.from({ length: n }, (_, i) => i);
const key = (key: string, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });

describe("columnFlow", () => {
  it("fills down, then across, without a trailing empty column", () => {
    const flow = columnFlow(items(15), 6, plain);
    expect(flow.columns.map(c => c.map(p => p.index))).toEqual([[0,1,2,3,4,5], [6,7,8,9,10,11], [12,13,14]]);
    expect(flow.columns.map(c => c.map(p => p.row))).toEqual([[0,1,2,3,4,5], [0,1,2,3,4,5], [0,1,2]]);
    expect(columnFlow(items(12), 6, plain).columns).toHaveLength(2);
    expect(columnFlow([], 4, plain).columns).toEqual([]);
  });
  it("wraps whole cards, resolves occupied spans, and leaves tail gaps empty", () => {
    const flow = columnFlow(items(10), 6, i => ({ slots: i === 5 ? 5 : 1, card: i === 5 }));
    expect(flow.byIndex[5]).toEqual({ index: 5, column: 1, row: 0, slots: 5 });
    expect(flow.atSlot(0, 5)).toBeUndefined();
    expect(flow.atSlot(1, 4)).toBe(flow.byIndex[5]);
    expect(flow.byIndex[6]).toEqual({ index: 6, column: 1, row: 5, slots: 1 });
    expect(flow.atSlot(-1, 0)).toBeUndefined();
    expect(flow.atSlot(1, 6)).toBeUndefined();
    expect(flow.atSlot(1, 0.5)).toBeUndefined();
  });
  it("shifts following items by the added slots and restores closed positions without history", () => {
    const source = Object.freeze(items(15));
    const before = columnFlow(source, 6, plain);
    const open = columnFlow(source, 6, i => ({ slots: i === 1 ? 5 : 1, card: i === 1 }));
    expect(open.byIndex[1]).toEqual({ index: 1, column: 0, row: 1, slots: 5 });
    for (const p of open.byIndex.slice(2)) expect(p.column * 6 + p.row - p.index).toBe(4);
    expect(columnFlow(source, 6, plain).byIndex).toEqual(before.byIndex);
    expect(columnFlow(source, 4, plain).byIndex[6]).toMatchObject({ column: 1, row: 2 });
  });
  it.each([0, 3, 4.5, NaN, Infinity, Number.MAX_VALUE])("rejects malformed R %s, even for empty input", R => {
    expect(() => columnFlow([], R, plain)).toThrow(RangeError);
  });
  it.each([null, undefined, {}, { slots: 0 }, { slots: 5, card: true }, { slots: 2, card: false }, { slots: NaN }, { slots: 1.5 }, { slots: Infinity }])("rejects malformed slots %j", value => {
    expect(() => columnFlow([0], 4, () => value as SlotSpec)).toThrow(RangeError);
  });
  it("handles 10,000 items and huge row capacities without a slot matrix", () => {
    const flow = columnFlow(items(10000), 4, plain);
    expect(flow.columns).toHaveLength(2500);
    expect(flow.atSlot(2499, 3)?.index).toBe(9999);
    const huge = columnFlow(items(10000), Number.MAX_SAFE_INTEGER, plain);
    expect(huge.columns).toHaveLength(1);
    expect(huge.atSlot(0, 9999)?.index).toBe(9999);
  });
  it("matches an independent occupied-slot oracle through seeded expansion, collapse and resize transitions", () => {
    let seed = 0x51c0ffee;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
    for (const R of [4,6,9,21]) for (const n of [15,90]) {
      let specs = items(n).map(plain);
      for (let step = 0; step < 120; step++) {
        const changed = random(n);
        specs = specs.map((s,i) => i === changed ? { slots: random(4) === 0 ? 1 : 1 + random(R), card: true } : s);
        // Advance an absolute occupied-slot cursor one slot at a time, independently of the prefix scan.
        let cursor = 0;
        const expected = specs.map((s,index) => {
          while (cursor % R + s.slots > R) cursor++;
          const placement = { index, column: Math.floor(cursor/R), row: cursor%R, slots: s.slots };
          cursor += s.slots;
          return placement;
        });
        const actual = columnFlow(specs, R, s => s);
        expect(actual.byIndex).toEqual(expected);
        for (const p of expected) for (let r = p.row; r < p.row + p.slots; r++) expect(actual.atSlot(p.column,r)).toEqual(p);
      }
      expect(columnFlow(items(n), R, plain).byIndex.map(p => p.column*R+p.row)).toEqual(items(n));
    }
  });
});

describe("List navigation and viewport contracts", () => {
  const flow = columnFlow(items(10), 4, plain);
  const move = (k: string, index: number, modifiers = {}, offset = 0) => resolveListMove(key(k, modifiers), flow, index, 550, offset);
  it("keeps arrows within columns and clamps across uneven final columns", () => {
    expect(move("ArrowUp", 5)).toMatchObject({ kind: "focus", index: 4 });
    expect(move("ArrowDown", 5)).toMatchObject({ kind: "focus", index: 6 });
    expect(move("ArrowDown", 7)).toEqual({ kind: "handled" });
    expect(move("ArrowUp", 4)).toEqual({ kind: "handled" });
    expect(move("ArrowLeft", 5)).toMatchObject({ index: 1 });
    expect(move("ArrowRight", 7)).toMatchObject({ index: 9 });
    expect(move("ArrowLeft", 0)).toEqual({ kind: "handled" });
    expect(move("ArrowRight", 9)).toEqual({ kind: "handled" });
  });
  it("supports Home/End and whole-column pages, retaining rows and clamping", () => {
    expect(move("Home", 5)).toMatchObject({ index: 0 });
    expect(move("End", 5)).toMatchObject({ index: 9 });
    expect(move("Home", 5, { metaKey: true })).toMatchObject({ index: 0 });
    expect(move("End", 5, { ctrlKey: true, shiftKey: true })).toMatchObject({ index: 9, selection: "extend" });
    expect(move("PageDown", 3)).toMatchObject({ index: 9 });
    expect(move("PageUp", 9)).toMatchObject({ index: 1 });
    expect(listPageColumns(535)).toBe(1);
    expect(listPageColumns(536)).toBe(2);
    expect(listPageColumns(0)).toBe(1);
  });
  it("preserves selection modifiers and excludes the creation sentinel", () => {
    expect(move("ArrowDown", 0, { ctrlKey: true })).toMatchObject({ index: 1, selection: "preserve" });
    expect(move("ArrowDown", 0, { shiftKey: true })).toMatchObject({ index: 1, selection: "extend" });
    expect(move("ArrowUp", 0, {}, 1)).toEqual({ kind: "handled" });
    expect(move("Home", 4, {}, 1)).toMatchObject({ index: 0 });
    expect(move("End", 4, {}, 1)).toMatchObject({ index: 8 });
  });
  it("handles empty, missing cursor, unsupported and malformed input", () => {
    expect(resolveListMove(key("ArrowDown"), columnFlow([],4,plain), -1, 500)).toEqual({ kind: "handled" });
    expect(move("ArrowDown", -1)).toMatchObject({ index: 0 });
    expect(move("Enter", 0)).toBeNull();
    expect(move("ArrowDown", 0, { altKey: true })).toBeNull();
    expect(move("ArrowDown", NaN)).toBeNull();
  });
  it("retains four rows below 120 usable pixels for the vertical fallback", () => {
    expect([0,60,119,120,149,150].map(listRows)).toEqual([4,4,4,4,4,5]);
  });
  it("windows columns with two overscan columns on each side", () => {
    expect(listColumnRange(100, 2760, 550)).toEqual({ start: 8, end: 14 });
    expect(listColumnRange(0, 0, 550)).toEqual({ start: 0, end: 0 });
    expect(listColumnRange(3, 100000, 550)).toEqual({ start: 0, end: 3 });
  });
  it("maps the dominant wheel axis, normalizes units, and leaves Ctrl-wheel alone", () => {
    expect(listWheelDelta({ deltaX: 10, deltaY: 50, deltaMode: 0, ctrlKey: false }, 500)).toBe(50);
    expect(listWheelDelta({ deltaX: -60, deltaY: 50, deltaMode: 0, ctrlKey: false }, 500)).toBe(-60);
    expect(listWheelDelta({ deltaX: 0, deltaY: 2, deltaMode: 1, ctrlKey: false }, 500)).toBe(60);
    expect(listWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2, ctrlKey: false }, 500)).toBe(-500);
    expect(listWheelDelta({ deltaX: 0, deltaY: 50, deltaMode: 0, ctrlKey: true }, 500)).toBeNull();
  });
});
