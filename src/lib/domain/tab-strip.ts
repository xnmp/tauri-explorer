/** Chrome-style tab sizing and search policy (#1705). All dimensions are CSS pixels. */
export const TAB_MAX_WIDTH = 220;
export const TAB_MIN_WIDTH = 32;
export const TAB_ACTIVE_MIN_WIDTH = 120;
export const TAB_GAP = 1;
/** Inactive tabs narrower than this show only their icon: below it the
 *  padding, icon and gap leave the title no more than a few faded pixels. */
export const TAB_ICON_ONLY_BELOW = 44;
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
