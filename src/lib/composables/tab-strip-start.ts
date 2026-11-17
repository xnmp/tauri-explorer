/**
 * Measures where the Floating Islands tab strip aligns with the content
 * islands (#1734): the strip padding (`tabStripPadding`) that puts its first
 * fillet past the leftmost content island's rounded corner, reported through
 * `onAligned` as islands resize, appear or disappear (sidebar resized or
 * hidden, preview opened). The tab bar decides how much of that alignment
 * its tabs can afford (`tabStripStart`).
 *
 * Synchronous and small, so the strip is aligned on first paint; the seam
 * marks, which need the alignment, load lazily.
 *
 * Its ResizeObserver watches only boxes shallower than anything the strip
 * lays out (the title bar, the main region and its direct children, such as
 * the sidebar and the workspace), so the padding it writes is delivered to
 * the strip's own observers in the same frame. Observing a deeper island
 * (a split pane sits far below the strip's scroller) made the write resize
 * a shallower observed box mid-delivery, which WebKit reports as a
 * ResizeObserver loop. Islands appearing, disappearing or splitting inside
 * the workspace without resizing it are structural: a MutationObserver
 * re-measures them (#1734).
 */
import { tabStripPadding, type IslandEdge } from "$lib/domain/tab-seam";
import { getZoomFactor } from "$lib/domain/zoom";
import { ISLANDS, STRUCTURAL } from "./island-regions";

/** Attributes that make or unmake an island without resizing its container. */
const STRUCTURE_ATTRIBUTES = ["data-split", "data-region", "data-island"];

export interface TabStripStart {
  destroy(): void;
}

export function attachTabStripStart(titlebar: HTMLElement, onAligned: (start: number | null) => void): TabStripStart {
  const observer = new ResizeObserver(() => measure());
  let watched = new Set<Element>();
  let reported: number | null | undefined;

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
    // The strip area's own left edge (its padding is the strip start).
    const aligned = area && content
      ? Math.round(tabStripPadding(content, (area.getBoundingClientRect().left - bar.left) / zoom) * 100) / 100
      : null;
    if (aligned !== reported) {
      reported = aligned;
      onAligned(aligned);
    }
    // Follow the boxes that exist now (see above).
    const main = document.querySelector('[data-region="main"]');
    if (main !== watchedMain) {
      structure.disconnect();
      if (main) structure.observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: STRUCTURE_ATTRIBUTES });
      watchedMain = main;
    }
    const next = new Set<Element>([titlebar, ...(main ? [main, ...main.children] : [])]);
    for (const el of watched) if (!next.has(el)) observer.unobserve(el);
    for (const el of next) if (!watched.has(el)) observer.observe(el);
    watched = next;
  }

  const structural = (node: Node) => node instanceof Element && (node.matches(ISLANDS) || node.querySelector(ISLANDS) !== null);
  const structure = new MutationObserver((records) => {
    if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some(structural))) measure();
  });
  let watchedMain: Element | null = null;

  measure();
  return {
    destroy() {
      observer.disconnect();
      structure.disconnect();
    },
  };
}
