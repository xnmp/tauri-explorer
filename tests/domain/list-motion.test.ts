import { describe, expect, it } from "vitest";
import { columnFlow, type ListFlowModel } from "$lib/domain/list-column-flow";
import { columnClip, easeOutCubic, listMotionSnapshot, motionRows, planListMotion, type MotionStep } from "$lib/domain/list-motion";

/** A model over named items; `cards` gives each open card's visible rows. */
function model(names: readonly string[], R: number, cards: Record<string, number> = {}): ListFlowModel {
  const items = names.map((name, index) => ({
    key: name, entryIndex: index,
    card: name in cards ? { path: name, start: 0, end: cards[name], visibleRows: cards[name] } : null,
  }));
  const layout = columnFlow(items, R, item => item.card ? { slots: 1 + item.card.visibleRows, card: true } : { slots: 1, card: false });
  return { layout, items, rowEntry: [], entryItem: new Int32Array(names.length).map((_, i) => i), entryOffset: new Int32Array(names.length).fill(-1) };
}
const names = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);
const all = () => true;
const byKey = (steps: MotionStep[] | null) => Object.fromEntries((steps ?? []).map(step => [step.key, step]));

describe("planListMotion", () => {
  const R = 6;
  const closed = listMotionSnapshot(model(names(15), R));
  const opened = listMotionSnapshot(model(names(15), R, { i1: 4 }));

  it("slides same-column items (FLIP) and grows the opening card from 0", () => {
    const steps = byKey(planListMotion(closed, opened, all));
    expect(steps.i0).toBeUndefined();
    expect(steps.i1.live).toEqual({ from: 0, clipColumn: null, rowsFrom: 0, rowsTo: 4, hidden: false });
    // i2 moves from (0,2) to (1,0): a conveyor; i6 from (1,0) to (1,4): a FLIP of 4 rows.
    expect(steps.i6.live).toMatchObject({ from: -120, clipColumn: null });
    expect(steps.i6.ghost).toBeNull();
  });

  it("moves column changers along the column path, live entering and ghost leaving the same distance", () => {
    const steps = byKey(planListMotion(closed, opened, all));
    // i2: (0,2) -> (1,0) = one column (6 slots) minus two rows = 4 slots.
    expect(steps.i2.live).toMatchObject({ from: -120, clipColumn: 1 });
    expect(steps.i2.ghost).toEqual({ column: 0, row: 2, to: 120, rowsFrom: null, rowsTo: 0 });
    for (const step of Object.values(steps)) if (step.live && step.ghost) expect(step.ghost.to).toBe(-step.live.from);
  });

  it("counts the empty slots a wrapped card leaves behind", () => {
    const before = listMotionSnapshot(model(names(12), R));
    const after = listMotionSnapshot(model(names(12), R, { i5: 4 }));
    const steps = byKey(planListMotion(before, after, all));
    // i5 wraps from (0,5) to (1,0): one slot along the path; i6 from (1,0) to (1,5).
    expect(steps.i5.ghost).toMatchObject({ column: 0, row: 5, to: 30 });
    expect(steps.i5.live).toMatchObject({ from: -30, clipColumn: 1, rowsFrom: 0, rowsTo: 4 });
    expect(steps.i6.live).toMatchObject({ from: -150, clipColumn: null });
    // i11: (1,5) -> (2,4): R - 1 slots, including the gap at (0,5).
    expect(steps.i11.live).toMatchObject({ from: -150, clipColumn: 2 });
  });

  it("closes a card in place under a shrinking ghost and reverses the conveyor", () => {
    const steps = byKey(planListMotion(opened, closed, all));
    expect(steps.i1).toEqual({ key: "i1",
      live: { from: 0, clipColumn: null, rowsFrom: null, rowsTo: 0, hidden: true },
      ghost: { column: 0, row: 1, to: 0, rowsFrom: 4, rowsTo: 0 } });
    expect(steps.i2.live).toMatchObject({ from: 120, clipColumn: 0 });
    expect(steps.i2.ghost).toMatchObject({ column: 1, row: 0, to: -120 });
  });

  it("closing a wrapped card sends its snapshot back while the row re-enters the earlier column", () => {
    const wrapped = listMotionSnapshot(model(names(12), R, { i5: 4 }));
    const steps = byKey(planListMotion(wrapped, listMotionSnapshot(model(names(12), R)), all));
    expect(steps.i5.ghost).toEqual({ column: 1, row: 0, to: -30, rowsFrom: 4, rowsTo: 0 });
    expect(steps.i5.live).toMatchObject({ from: 30, clipColumn: 0, rowsFrom: null, hidden: false });
  });

  it("resizes a card's content height and shifts what follows", () => {
    const shorter = listMotionSnapshot(model(names(15), R, { i1: 3 }));
    const steps = byKey(planListMotion(opened, shorter, all));
    expect(steps.i1.live).toEqual({ from: 0, clipColumn: null, rowsFrom: 4, rowsTo: 3, hidden: false });
    expect(Object.keys(steps).sort()).toEqual(names(15).slice(1).sort());
  });

  it("animates only columns intersecting the viewport", () => {
    const visible = (column: number) => column === 1;
    const steps = byKey(planListMotion(closed, opened, visible));
    expect(steps.i1).toBeUndefined(); // column 0
    expect(steps.i2.live).not.toBeNull(); // enters visible column 1
    expect(steps.i2.ghost).toBeNull(); // left from hidden column 0
    expect(steps.i5.live).not.toBeNull();
    const twelve = steps.i12; // (2,0) -> (2,4): hidden column 2
    expect(twelve).toBeUndefined();
    expect(planListMotion(closed, opened, () => false)).toBeNull();
  });

  it("is instant for a rows-per-column change, a first layout, or no visible change", () => {
    const resized = listMotionSnapshot(model(names(15), 7, { i1: 4 }));
    expect(planListMotion(opened, resized, all)).toBeNull();
    expect(planListMotion(null, opened, all)).toBeNull();
    expect(planListMotion(opened, listMotionSnapshot(model(names(15), R, { i1: 4 })), all)).toBeNull();
  });

  it("ignores items that appear or disappear (snap)", () => {
    const fewer = listMotionSnapshot(model(names(10), R));
    expect(planListMotion(closed, fewer, all)).toBeNull();
    const more = listMotionSnapshot(model(["x", ...names(15)], R));
    expect(byKey(planListMotion(closed, more, all)).x).toBeUndefined();
  });

  it("plans 10,000 items with several cards in bounded time", () => {
    const many = names(10_000);
    const before = listMotionSnapshot(model(many, 21, { i10: 6, i500: 6 }));
    const after = listMotionSnapshot(model(many, 21, { i10: 6, i500: 6, i40: 14 }));
    const started = performance.now();
    const steps = planListMotion(before, after, column => column < 6)!;
    expect(performance.now() - started).toBeLessThan(500);
    expect(steps.every(step => (step.live ? after.items.get(step.key)!.column < 6 : true) && (step.ghost ? step.ghost.column < 6 : true))).toBe(true);
  });
});

describe("motion helpers", () => {
  it("eases out cubically and clamps its input", () => {
    expect([0, 1, -1, 2].map(easeOutCubic)).toEqual([0, 1, 0, 1]);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });
  it("interpolates card rows and keeps travelling elements inside their column", () => {
    expect(motionRows(0, 4, 0.5)).toBe(2);
    expect(motionRows(null, 4, 0)).toBe(4);
    expect(columnClip(60, -120, 30, 180)).toEqual({ top: 60, bottom: 0 });
    expect(columnClip(150, 60, 30, 180)).toEqual({ top: 0, bottom: 60 });
    expect(columnClip(30, 0, 30, 180)).toEqual({ top: 0, bottom: 0 });
  });
});
