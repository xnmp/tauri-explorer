/**
 * Measures where the Floating Islands tab strip starts (#1734, #1785): the
 * strip padding (`tabStripPadding`) that puts the first tab's foot past the
 * rounded top-left corner of the tab's surface, reported through `onAligned`
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

export interface TabStripStart {
  destroy(): void;
}

export function attachTabStripStart(titlebar: HTMLElement, onAligned: (start: number | null) => void): TabStripStart {
  let reported: number | null | undefined;

  function measure(): void {
    const area = titlebar.querySelector<HTMLElement>('[data-region="tab-strip"]');
    const zoom = getZoomFactor() || 1;
    const bar = titlebar.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(titlebar).getPropertyValue("--layout-radius")) || 0;
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
