import { describe, expect, it } from 'vitest';
import { planEntryReflow, type EntryPosition } from '$lib/domain/entry-reflow';

const at = (entries: [string, number, number][]) => new Map<string, EntryPosition>(entries.map(([k, x, y]) => [k, { x, y }]));

describe('planEntryReflow', () => {
  it('moves each entry from where it was painted to its new cell', () => {
    // 8 columns -> 4: entry 4 wraps from row 0 to row 1.
    const before = at([['a', 0, 0], ['e', 400, 0]]);
    const after = at([['a', 0, 0], ['e', 0, 100]]);
    expect(planEntryReflow(before, after)).toEqual([{ key: 'e', dx: 400, dy: -100 }]);
  });

  it('leaves newly mounted entries in place: a scrolled pane can mount an entirely new range', () => {
    expect(planEntryReflow(at([['old', 0, 0]]), at([['new', 10, 20]]))).toEqual([]);
  });

  it('ignores entries that left the rendered range: there is nothing left to animate', () => {
    expect(planEntryReflow(at([['gone', 0, 0]]), at([]))).toEqual([]);
  });

  it('treats sub-pixel layout noise as still, but keeps a half-pixel move', () => {
    const before = at([['still', 10.2, 20.3], ['moved', 10, 20]]);
    const after = at([['still', 10, 20], ['moved', 10.5, 20]]);
    expect(planEntryReflow(before, after)).toEqual([{ key: 'moved', dx: -0.5, dy: 0 }]);
  });

  it('skips non-finite measurements rather than producing NaN transforms', () => {
    expect(planEntryReflow(at([['x', NaN, 0], ['y', Infinity, 0]]), at([['x', 0, 0], ['y', 0, 0]]))).toEqual([]);
  });

  it('plans a large grid in one pass', () => {
    const count = 20_000;
    const before = at(Array.from({ length: count }, (_, i) => [`f${i}`, (i % 8) * 90, Math.floor(i / 8) * 100] as [string, number, number]));
    const after = at(Array.from({ length: count }, (_, i) => [`f${i}`, (i % 4) * 90, Math.floor(i / 4) * 100] as [string, number, number]));
    const steps = planEntryReflow(before, after);
    // Indices 0-3 keep their cells in row 0; every other entry moves.
    expect(steps).toHaveLength(count - 4);
    expect(steps[0]).toEqual({ key: 'f4', dx: 360, dy: -100 });
  });
});
