import { expect, it } from 'vitest';
import { NO_PANE_INSET, stablePaneFrame, visiblePaneRect } from '$lib/domain/pane-motion';

it.each([
  { x: 0, y: 0, w: 500, h: 800 },
  { x: 500, y: 0, w: 500, h: 800 },
  { x: 0, y: 0, w: 1000, h: 400 },
  { x: 0, y: 400, w: 1000, h: 400 },
])('preserves old content dimensions while revealing the final bounds $x,$y,$w,$h', target => {
  const source = { x: 0, y: 0, w: 1000, h: 800 };
  const plan = stablePaneFrame(source, NO_PANE_INSET, target);
  expect([plan.from.w, plan.from.h]).toEqual([plan.to.w, plan.to.h]);
  expect(visiblePaneRect(plan.from, plan.fromClip)).toEqual(source);
  expect(visiblePaneRect(plan.to, plan.toClip)).toEqual(target);
});

it('carries an interrupted reveal without mistaking held content size for visible size', () => {
  const source = { x: 0, y: 0, w: 1000, h: 800 };
  const plan = stablePaneFrame(source, [0, 350, 0, 0], { x: 0, y: 0, w: 250, h: 800 });
  expect(visiblePaneRect(plan.from, plan.fromClip)).toEqual({ x: 0, y: 0, w: 650, h: 800 });
  expect(visiblePaneRect(plan.to, plan.toClip)).toEqual({ x: 0, y: 0, w: 250, h: 800 });
  expect(plan.from.w).toBe(plan.to.w);
});

it('also handles a growing or moving survivor without resizing its content each frame', () => {
  const source = { x: 100, y: 20, w: 240, h: 200 };
  const target = { x: 400, y: 80, w: 500, h: 350 };
  const plan = stablePaneFrame(source, NO_PANE_INSET, target);
  expect(visiblePaneRect(plan.from, plan.fromClip)).toEqual(source);
  expect(visiblePaneRect(plan.to, plan.toClip)).toEqual(target);
  expect([plan.from.w, plan.from.h]).toEqual([plan.to.w, plan.to.h]);
});

it('keeps fully clipped panes empty for hit testing', () => {
  expect(visiblePaneRect({ x: 0, y: 0, w: 200, h: 200 }, [0, 210, 0, 0]).w).toBe(0);
});
