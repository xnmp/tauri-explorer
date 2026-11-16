import { describe, expect, it } from 'vitest';
import { filterOpenTabs, tabEdgeScrollSpeed, tabStripLayout } from '$lib/domain/tab-strip';

describe('Chrome tab sizing', () => {
  it('caps comfortable tabs and gives crowded inactive tabs space back to the active label', () => {
    expect(tabStripLayout(3, 1200).activeWidth).toBe(220);
    const crowded = tabStripLayout(18, 750);
    expect(crowded.activeWidth).toBeGreaterThanOrEqual(120);
    expect(crowded.inactiveWidth).toBeGreaterThanOrEqual(32);
    expect(crowded.inactiveWidth).toBeLessThan(64);
    expect(crowded.iconOnly).toBe(true);
    expect(crowded.totalWidth).toBeCloseTo(750);
    expect(crowded.overflowing).toBe(false);
  });

  it('uses scrolling rather than shrinking hit targets away at extreme counts', () => {
    const layout = tabStripLayout(100, 300);
    expect(layout.inactiveWidth).toBe(32);
    expect(layout.activeWidth).toBe(120);
    expect(layout.overflowing).toBe(true);
    expect(layout.totalWidth).toBeGreaterThan(300);
  });

  it('reserves a wider edit field and still fits when enough space exists', () => {
    const layout = tabStripLayout(10, 600, 180);
    expect(layout.activeWidth).toBe(180);
    expect(layout.totalWidth).toBeCloseTo(600);
    expect(layout.overflowing).toBe(false);
  });

  it.each([0, -10, NaN, Infinity])('handles an empty or invalid count %s without allocating tabs', count => {
    expect(tabStripLayout(count, 300)).toEqual({ activeWidth: 0, inactiveWidth: 0, iconOnly: false, overflowing: false, totalWidth: 0 });
  });

  it.each([0, -100, NaN, Infinity])('keeps usable geometry for invalid or unmeasured width %s', width => {
    const layout = tabStripLayout(2, width);
    expect(layout.activeWidth).toBe(120);
    expect(layout.inactiveWidth).toBe(32);
    expect(layout.overflowing).toBe(true);
  });

  it('handles one tab and huge tab counts with finite geometry', () => {
    expect(tabStripLayout(1, 180)).toMatchObject({ activeWidth: 180, totalWidth: 180, overflowing: false });
    expect(Number.isFinite(tabStripLayout(1_000_000, 1000).totalWidth)).toBe(true);
  });
});

describe('open tab search', () => {
  const tabs = [
    { id: 'a', title: 'src', path: '/work/Explorer/src' },
    { id: 'b', title: 'src', path: '/work/website/src' },
    { id: 'c', title: 'Research workspace', path: '/notes\n/work/website/docs' },
  ];
  it('uses full paths and case-insensitive words to distinguish identical folder names', () => {
    expect(filterOpenTabs(tabs, ' SRC  explorer ').map(tab => tab.id)).toEqual(['a']);
  });
  it('matches renamed multi-pane workspaces and every pane path without reordering', () => {
    expect(filterOpenTabs(tabs, 'website').map(tab => tab.id)).toEqual(['b', 'c']);
    expect(filterOpenTabs(tabs, 'RESEARCH docs').map(tab => tab.id)).toEqual(['c']);
  });
  it('handles empty search, no results, and literal regex characters', () => {
    expect(filterOpenTabs(tabs, ' \n ')).toEqual(tabs);
    expect(filterOpenTabs(tabs, '[.*')).toEqual([]);
    expect(filterOpenTabs([], 'src')).toEqual([]);
  });
});

describe('tab drag edge scrolling', () => {
  it('scrolls toward an edge with bounded speed and leaves the center alone', () => {
    expect(tabEdgeScrollSpeed(0, 300)).toBe(-360);
    expect(tabEdgeScrollSpeed(12, 300)).toBe(-180);
    expect(tabEdgeScrollSpeed(150, 300)).toBe(0);
    expect(tabEdgeScrollSpeed(288, 300)).toBe(180);
    expect(tabEdgeScrollSpeed(300, 300)).toBe(360);
  });
  it('stops outside the viewport and handles tiny or unmeasured widths', () => {
    expect(tabEdgeScrollSpeed(-1, 300)).toBe(0);
    expect(tabEdgeScrollSpeed(301, 300)).toBe(0);
    expect(tabEdgeScrollSpeed(0, 0)).toBe(0);
    expect(tabEdgeScrollSpeed(NaN, 300)).toBe(0);
    expect(tabEdgeScrollSpeed(4, 9)).toBe(0);
  });
});
