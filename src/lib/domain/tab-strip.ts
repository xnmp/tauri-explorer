/** Chrome-style tab sizing and search policy (#1705). All dimensions are CSS pixels. */
export const TAB_MAX_WIDTH = 220;
export const TAB_MIN_WIDTH = 32;
export const TAB_ACTIVE_MIN_WIDTH = 120;
export const TAB_GAP = 1;
/** Inactive tabs narrower than this show only their icon. An inactive tab
 *  spends about 40px on padding, icon and gap, and its title fades out over
 *  its last 16px; below this width the title box is narrower than 1.5× that
 *  fade, so it would show only faded fragments of letters (#1734). */
export const TAB_ICON_ONLY_BELOW = 64;
/** Inactive tab width the strip keeps before it gives up aligning with the
 *  content islands: an icon plus a short readable title (#1734). */
export const TAB_COMFORT_WIDTH = 72;
/** Room the tab viewport keeps beside its tabs so the active tab's fillets
 *  (14px) and their 1px ring are never clipped by the scroller (#1734). */
export const TAB_BLEED = 15;

export function tabStripLayout(count: number, availableWidth: number, activeMinimum = TAB_ACTIVE_MIN_WIDTH) {
  const size = Number.isFinite(count) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(count))) : 0;
  const available = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0;
  const minimum = Number.isFinite(activeMinimum)
    ? Math.min(TAB_MAX_WIDTH, Math.max(TAB_MIN_WIDTH, activeMinimum)) : TAB_ACTIVE_MIN_WIDTH;
  if (size === 0) return { activeWidth: 0, inactiveWidth: 0, iconOnly: false, overflowing: false, totalWidth: 0 };
  const space = Math.max(0, available - (size - 1) * TAB_GAP);
  const activeWidth = Math.min(TAB_MAX_WIDTH, Math.max(minimum, space / size));
  const inactiveWidth = size === 1 ? 0
    : Math.min(TAB_MAX_WIDTH, Math.max(TAB_MIN_WIDTH, (space - activeWidth) / (size - 1)));
  const totalWidth = activeWidth + inactiveWidth * (size - 1) + TAB_GAP * (size - 1);
  return { activeWidth, inactiveWidth, iconOnly: inactiveWidth < TAB_ICON_ONLY_BELOW, overflowing: totalWidth > available + 0.5, totalWidth };
}

/**
 * Where the tab strip starts, as its left padding (#1734).
 *
 * Floating Islands aligns the strip with the content islands (`aligned`, see
 * `tabStripPadding`), so tabs stand over the content they open. That
 * indentation is a nicety, never worth crowding the tabs: while `count` tabs
 * fit at their comfortable width (the active tab's minimum plus
 * `TAB_COMFORT_WIDTH` per other tab) in the room left after it, the strip is
 * aligned; otherwise it gives back exactly the room they lack, down to the
 * window-edge start `floor`. Only then do tabs narrow, go icon-only and
 * overflow.
 *
 * @param room the tabs' room with the strip at `floor` (CSS px)
 */
export function tabStripStart(
  aligned: number,
  floor: number,
  room: number,
  count: number,
  activeMinimum = TAB_ACTIVE_MIN_WIDTH,
): number {
  const base = Number.isFinite(floor) ? Math.max(0, floor) : 0;
  if (!Number.isFinite(aligned) || aligned <= base) return base;
  const tabs = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const active = Number.isFinite(activeMinimum) ? Math.min(TAB_MAX_WIDTH, Math.max(TAB_MIN_WIDTH, activeMinimum)) : TAB_ACTIVE_MIN_WIDTH;
  const needed = tabs === 0 ? 0 : active + (tabs - 1) * (TAB_COMFORT_WIDTH + TAB_GAP);
  const slack = (Number.isFinite(room) ? room : 0) - needed;
  return base + Math.min(aligned - base, Math.max(0, slack));
}

export interface SearchableTab {
  readonly id: string;
  readonly title: string;
  readonly path: string;
}

/** Match every word against the title and every pane's path; preserve tab order. */
export function filterOpenTabs<T extends SearchableTab>(tabs: readonly T[], query: string): readonly T[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return tabs;
  return tabs.filter(tab => {
    const text = `${tab.title}\n${tab.path}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** Bounded edge-scroll speed, in CSS pixels/second, while reordering tabs. */
export function tabEdgeScrollSpeed(pointer: number, width: number): number {
  if (!Number.isFinite(pointer) || !Number.isFinite(width) || width <= 0 || pointer < 0 || pointer > width) return 0;
  const edge = Math.min(24, width / 3);
  if (pointer < edge) return -360 * (1 - pointer / edge);
  if (pointer > width - edge) return 360 * (1 - (width - pointer) / edge);
  return 0;
}

/**
 * Scroll delta that reveals a tab inside the tab viewport, leaving up to
 * `bleed` of room on the near side so its fillets stay visible. The room
 * shrinks when the tab nearly fills the viewport; a tab wider than the
 * viewport aligns its leading edge.
 */
export function tabRevealDelta(
  tab: { readonly left: number; readonly right: number },
  view: { readonly left: number; readonly right: number },
  bleed = TAB_BLEED,
): number {
  const values = [tab.left, tab.right, view.left, view.right];
  if (!values.every(Number.isFinite)) return 0;
  const tabWidth = Math.max(0, tab.right - tab.left);
  const viewWidth = Math.max(0, view.right - view.left);
  const room = Math.max(0, Math.min(Number.isFinite(bleed) ? bleed : 0, (viewWidth - tabWidth) / 2));
  if (tab.left < view.left + room || tabWidth > viewWidth) return tab.left - (view.left + room);
  if (tab.right > view.right - room) return tab.right - (view.right - room);
  return 0;
}

/**
 * The scroll position that shows the active tab (`index`) of a strip laid
 * out as `layout`, from the layout itself rather than the rendered tabs
 * (#1734). While a tab slides in or out the rendered strip is between two
 * layouts (a seed, tabs still easing), and revealing that transient geometry
 * scrolled the strip one way, then back. Tabs before the active one are
 * inactive; the scroller pads its content by `bleed` on both ends. A strip
 * that fits rests unscrolled, however narrow the scroller is mid-slide.
 *
 * @param room space kept beside the tab for its fillets (and, overflowing,
 *             the scroll button and edge fade overlaid on each end)
 */
export function tabRevealScroll(
  layout: { readonly activeWidth: number; readonly inactiveWidth: number; readonly totalWidth: number; readonly overflowing?: boolean },
  index: number,
  scrollLeft: number,
  viewWidth: number,
  room: number,
  bleed = TAB_BLEED,
): number {
  const values = [layout.activeWidth, layout.inactiveWidth, layout.totalWidth, scrollLeft, viewWidth, bleed];
  if (!values.every(Number.isFinite) || !Number.isFinite(index) || index < 0) return Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0;
  if (layout.overflowing === false) return 0;
  const left = bleed + Math.floor(index) * (layout.inactiveWidth + TAB_GAP);
  const delta = tabRevealDelta({ left, right: left + layout.activeWidth }, { left: scrollLeft, right: scrollLeft + Math.max(0, viewWidth) }, room);
  const max = Math.max(0, layout.totalWidth + 2 * bleed - Math.max(0, viewWidth));
  return Math.min(max, Math.max(0, scrollLeft + delta));
}
