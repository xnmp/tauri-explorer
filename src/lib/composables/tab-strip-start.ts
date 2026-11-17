/**
 * Aligns the Floating Islands tab strip with the content islands (#1734):
 * publishes `--tab-strip-pad` on the title bar, the strip's left padding
 * from `tabStripPadding`, and keeps it in step as islands resize, appear or
 * disappear (sidebar resized or hidden, preview opened).
 *
 * Synchronous and small, so the strip is aligned on first paint; the seam
 * marks, which need the alignment, load lazily.
 */
import { tabStripPadding, type IslandEdge } from "$lib/domain/tab-seam";
import { getZoomFactor } from "$lib/domain/zoom";
import { ISLANDS, STRUCTURAL } from "./island-regions";

export interface TabStripStart {
  destroy(): void;
}

export function attachTabStripStart(titlebar: HTMLElement): TabStripStart {
  const observer = new ResizeObserver(() => measure());
  let watched = new Set<Element>();

  function measure(): void {
    const area = titlebar.querySelector<HTMLElement>('[data-region="tab-strip"]');
    const zoom = getZoomFactor() || 1;
    const bar = titlebar.getBoundingClientRect();
    const base = bar.bottom;
    const islands = [...document.querySelectorAll<HTMLElement>(ISLANDS)];
    let content: IslandEdge | null = null;
    for (const el of islands) {
      const box = el.getBoundingClientRect();
      if (!box.width || el.matches(STRUCTURAL) || Math.abs(box.top - base) > 1) continue;
      const left = (box.left - bar.left) / zoom;
      if (!content || left < content.left) {
        content = { left, right: (box.right - bar.left) / zoom, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 };
      }
    }
    if (area) {
      const areaLeft = (area.getBoundingClientRect().left - bar.left) / zoom;
      titlebar.style.setProperty("--tab-strip-pad", `${Math.round(tabStripPadding(content, areaLeft) * 100) / 100}px`);
    }
    // Follow the islands that exist now: any of them resizing, appearing or
    // disappearing can move the leftmost content island.
    const next = new Set<Element>([titlebar, ...islands]);
    const main = document.querySelector('[data-region="main"]');
    if (main) next.add(main);
    for (const el of watched) if (!next.has(el)) observer.unobserve(el);
    for (const el of next) if (!watched.has(el)) observer.observe(el);
    watched = next;
  }

  measure();
  return {
    destroy() {
      observer.disconnect();
      titlebar.style.removeProperty("--tab-strip-pad");
    },
  };
}
