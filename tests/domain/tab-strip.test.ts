import { describe, expect, it } from 'vitest';
import { filterOpenTabs, tabEdgeScrollSpeed, tabRevealDelta, tabRevealScroll, tabSearchShown, tabStripLayout, tabStripStart, TAB_ACTIVE_MIN_WIDTH, TAB_BLEED, TAB_COMFORT_WIDTH, TAB_GAP, TAB_ICON_ONLY_BELOW } from '$lib/domain/tab-strip';

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

describe('tabRevealDelta', () => {
  const view = { left: 0, right: 300 };
  it('leaves fillet room on the side it scrolls toward', () => {
    expect(tabRevealDelta({ left: -50, right: 70 }, view)).toBe(-50 - TAB_BLEED);
    expect(tabRevealDelta({ left: 250, right: 370 }, view)).toBe(70 + TAB_BLEED);
    expect(tabRevealDelta({ left: 20, right: 140 }, view)).toBe(0);
  });
  it('narrows the room when the tab nearly fills the viewport, and aligns an oversized tab', () => {
    expect(tabRevealDelta({ left: 10, right: 290 }, view)).toBe(0);
    expect(tabRevealDelta({ left: 400, right: 690 }, view)).toBe(400 - 5);
    expect(tabRevealDelta({ left: 40, right: 400 }, view)).toBe(40);
  });
  it('ignores malformed geometry', () => {
    expect(tabRevealDelta({ left: Number.NaN, right: 3 }, view)).toBe(0);
  });
});

describe('tab strip start (#1734)', () => {
  // A 1100px Floating Islands window: the content island's straight top
  // edge starts 282px in; at the 12px window-edge start the tabs have 760px.
  const aligned = 282;
  const floor = 12;

  it('aligns with the content islands while the tabs fit at a comfortable width', () => {
    expect(tabStripStart(aligned, floor, 760, 3)).toBe(aligned);
    expect(tabStripStart(aligned, floor, 760, 6)).toBe(aligned);
  });

  it('gives back exactly the room comfortable tabs lack, a pixel at a time', () => {
    // 700px window: about 420px of room at the floor.
    const room = 420;
    const starts = [1, 2, 3, 4, 5, 6].map(count => tabStripStart(aligned, floor, room, count));
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeLessThanOrEqual(starts[i - 1]);
    const four = tabStripStart(aligned, floor, room, 4);
    expect(four).toBeGreaterThan(floor);
    expect(four).toBeLessThan(aligned);
    // The tabs then have their comfortable width, and no more.
    const left = room - (four - floor);
    expect(left).toBeCloseTo(TAB_ACTIVE_MIN_WIDTH + 3 * (TAB_COMFORT_WIDTH + TAB_GAP));
    const layout = tabStripLayout(4, left);
    expect(layout.iconOnly).toBe(false);
    expect(layout.overflowing).toBe(false);
  });

  it('starts at the window edge before any tab narrows below its comfortable width', () => {
    expect(tabStripStart(aligned, floor, 300, 4)).toBe(floor);
    expect(tabStripStart(aligned, floor, 300, 40)).toBe(floor);
  });

  it('never aligns before the floor or with a missing island', () => {
    expect(tabStripStart(4, floor, 760, 3)).toBe(floor);
    expect(tabStripStart(Number.NaN, floor, 760, 3)).toBe(floor);
    expect(tabStripStart(Number.POSITIVE_INFINITY, floor, 760, 3)).toBe(floor);
  });

  it('reserves a wider active tab while renaming', () => {
    expect(tabStripStart(aligned, floor, 420, 3, 180)).toBeLessThan(tabStripStart(aligned, floor, 420, 3));
  });

  it.each([NaN, -50, Infinity])('treats an unmeasured room %s as no room', room => {
    expect(tabStripStart(aligned, floor, room, 3)).toBe(floor);
  });

  it('keeps every count finite, including none and huge counts', () => {
    expect(tabStripStart(aligned, floor, 760, 0)).toBe(aligned);
    expect(tabStripStart(aligned, floor, 760, Number.NaN)).toBe(aligned);
    expect(tabStripStart(aligned, floor, 760, 1_000_000)).toBe(floor);
  });
});

describe('icon-only threshold (#1734)', () => {
  it('shows a title only where its box is at least 1.5x the 16px fade', () => {
    // An inactive tab spends about 40px on padding, icon and gap.
    expect(TAB_ICON_ONLY_BELOW - 40).toBeGreaterThanOrEqual(24);
    const crowded = tabStripLayout(12, 600);
    expect(crowded.iconOnly).toBe(crowded.inactiveWidth < TAB_ICON_ONLY_BELOW);
  });
});

describe('revealing the active tab from its layout (#1734)', () => {
  // 560px Floating Islands strip: eight tabs overflow a 374px scroller by 7px.
  const layout = tabStripLayout(8, 344);
  const view = 374;
  const room = TAB_BLEED + 24 + 24;

  it('scrolls an overflowing strip just far enough to show the last tab beside the overlays', () => {
    expect(layout.overflowing).toBe(true);
    const target = tabRevealScroll(layout, 7, 0, view, room);
    const left = TAB_BLEED + 7 * (layout.inactiveWidth + TAB_GAP);
    expect(left + layout.activeWidth - target).toBeLessThanOrEqual(view);
    expect(target).toBeCloseTo(layout.totalWidth + 2 * TAB_BLEED - view);
  });

  it('never scrolls a strip that fits, and leaves a shown tab where it is', () => {
    expect(tabRevealScroll(tabStripLayout(3, 344), 2, 40, view, room)).toBe(0);
    const wide = tabStripLayout(30, 344);
    const shown = tabRevealScroll(wide, 10, 0, view, room);
    expect(tabRevealScroll(wide, 10, shown, view, room)).toBe(shown);
  });

  it('rests a strip that fits unscrolled while its scroller is still narrower mid-slide', () => {
    const fits = tabStripLayout(4, 790);
    expect(fits.overflowing).toBe(false);
    expect(fits.totalWidth + 2 * TAB_BLEED).toBeGreaterThan(640);
    expect(tabRevealScroll(fits, 3, 0, 640, room)).toBe(0);
    expect(tabRevealScroll(fits, 3, 18, 640, room)).toBe(0);
  });

  it('reveals the first tab by scrolling back to the start', () => {
    expect(tabRevealScroll(tabStripLayout(30, 344), 0, 500, view, room)).toBe(0);
  });

  it.each([NaN, -1, Infinity])('keeps the scroll position for an invalid index %s', index => {
    expect(tabRevealScroll(layout, index, 12, view, room)).toBe(12);
  });

  it('stays within the scroll range for unmeasured views and huge strips', () => {
    expect(tabRevealScroll(layout, 7, 0, 0, room)).toBeLessThanOrEqual(layout.totalWidth + 2 * TAB_BLEED);
    const huge = tabStripLayout(100_000, 344);
    const target = tabRevealScroll(huge, 99_999, 0, view, room);
    expect(Number.isFinite(target)).toBe(true);
    expect(target).toBeLessThanOrEqual(huge.totalWidth + 2 * TAB_BLEED - view);
  });
});

describe("tabSearchShown (#1881)", () => {
  it("hides the search while every tab keeps a readable title", () => {
    for (const count of [0, 1, 2, 3]) {
      expect(tabSearchShown(count, tabStripLayout(count, 900))).toBe(false);
    }
  });

  it("hides it for a lone tab even in a sliver of room", () => {
    expect(tabSearchShown(1, tabStripLayout(1, 10))).toBe(false);
  });

  it("shows it once inactive tabs shrink to icons", () => {
    const layout = tabStripLayout(14, 900);
    expect(layout.iconOnly && !layout.overflowing).toBe(true);
    expect(tabSearchShown(14, layout)).toBe(true);
  });

  it("shows it while the strip scrolls", () => {
    expect(tabSearchShown(60, tabStripLayout(60, 900))).toBe(true);
  });
});
