/**
 * Measures where the tab strip starts when the active tab owns the window
 * (#1734, #1785, #1856): the strip padding (`tabStripPadding`) that puts the
 * first tab's foot past the top-left corner of the tab's surface, reported through `onAligned`
 * as the strip's room moves (window controls or the integrated title bar's
 * traffic-light inset). The tab bar decides how much of that alignment its
 * tabs can afford (`tabStripStart`).
 *
 * Synchronous and small, so the strip is aligned on first paint; the seam
 * marks load lazily. It observes only the title bar and the strip's room box,
 * whose size nothing the strip lays out inside it changes, so the padding it
 * writes never feeds back into its own observation.
 */
import { tabStripPadding } from "$lib/domain/tab-seam";
import { getZoomFactor } from "$lib/domain/zoom";

/**
 * The surface's corner radius in CSS pixels: `--islands-surface-radius`, a
 * registered length Floating Islands sets from `--layout-radius` (Default:
 * 0), so any unit a layout uses (rem, em, calc) arrives resolved.
 */
export function surfaceRadius(titlebar: HTMLElement): number {
  return parseFloat(getComputedStyle(titlebar).getPropertyValue("--islands-surface-radius")) || 0;
}

export interface TabStripStart {
  destroy(): void;
}

export function attachTabStripStart(titlebar: HTMLElement, onAligned: (start: number | null) => void): TabStripStart {
  let reported: number | null | undefined;

  function measure(): void {
    const area = titlebar.querySelector<HTMLElement>('[data-region="tab-strip"]');
    const zoom = getZoomFactor() || 1;
    const bar = titlebar.getBoundingClientRect();
    const radius = surfaceRadius(titlebar);
    // The strip area's own left edge (its padding is the strip start).
    const aligned = area
      ? Math.round(tabStripPadding({ left: 0, right: bar.width / zoom, radius }, (area.getBoundingClientRect().left - bar.left) / zoom) * 100) / 100
      : null;
    if (aligned !== reported) {
      reported = aligned;
      onAligned(aligned);
    }
  }

  const observer = new ResizeObserver(() => measure());
  observer.observe(titlebar);
  const room = titlebar.querySelector("[data-tab-room-box]");
  if (room) observer.observe(room);
  measure();
  return {
    destroy() {
      observer.disconnect();
    },
  };
}
