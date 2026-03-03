/**
 * Marquee (rubber-band) selection composable for FileList.
 * Issue: tauri-explorer-1k9k
 *
 * Extracts marquee selection logic from FileList to reduce complexity.
 */

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarqueeOptions {
  headerHeight?: number;
  itemHeight?: number;
  backgroundClasses?: string[];
}

const DEFAULT_OPTIONS: Required<MarqueeOptions> = {
  headerHeight: 32,
  itemHeight: 32,
  backgroundClasses: [
    "file-rows",
    "content",
    "details-view",
    "tiles-view",
    "virtual-viewport",
    "virtual-spacer-top",
    "virtual-spacer-bottom",
  ],
};

import { getZoomFactor } from "$lib/domain/zoom";

export function useMarqueeSelection(options: MarqueeOptions = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  let isDragging = $state(false);
  let dragEndTime = 0;
  const DRAG_END_GRACE_MS = 50;
  let dragStart = $state<{ x: number; y: number } | null>(null);
  let dragCurrent = $state<{ x: number; y: number } | null>(null);
  let ctrlKeyHeld = $state(false);

  const marqueeRect = $derived.by((): MarqueeRect | null => {
    if (!dragStart || !dragCurrent) return null;
    return {
      left: Math.min(dragStart.x, dragCurrent.x),
      top: Math.min(dragStart.y, dragCurrent.y),
      width: Math.abs(dragCurrent.x - dragStart.x),
      height: Math.abs(dragCurrent.y - dragStart.y),
    };
  });

  function isBackgroundClick(target: HTMLElement): boolean {
    return config.backgroundClasses.some((cls) => target.classList.contains(cls));
  }

  function start(event: MouseEvent, containerRect: DOMRect): void {
    if (!isBackgroundClick(event.target as HTMLElement)) return;
    if (event.button !== 0) return; // Only left click

    // Blur any focused element before starting marquee
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    isDragging = true;
    ctrlKeyHeld = event.ctrlKey || event.metaKey;
    // Compensate for CSS zoom: clientX/Y are physical pixels in WebKitGTK,
    // but containerRect is in CSS (zoomed) pixels.
    const zoom = getZoomFactor();
    dragStart = {
      x: event.clientX / zoom - containerRect.left,
      y: Math.max(config.headerHeight, event.clientY / zoom - containerRect.top),
    };
    dragCurrent = { ...dragStart };

    event.preventDefault();
  }

  function move(event: MouseEvent, containerRect: DOMRect): void {
    if (!isDragging) return;

    const zoom = getZoomFactor();
    dragCurrent = {
      x: Math.max(0, Math.min(event.clientX / zoom - containerRect.left, containerRect.width)),
      y: Math.max(config.headerHeight, event.clientY / zoom - containerRect.top),
    };
  }

  function end(): void {
    if (!isDragging) return;

    isDragging = false;
    dragStart = null;
    dragCurrent = null;

    // Record end time so click handlers can ignore the immediate click
    dragEndTime = performance.now();
  }

  /**
   * Calculate indices of items intersecting with the marquee rectangle.
   * @param scrollTop Current scroll position of the container
   * @param totalItems Total number of items in the list
   */
  function getSelectedIndices(scrollTop: number, totalItems: number): number[] {
    if (!marqueeRect) return [];

    const marqueeTop = marqueeRect.top + scrollTop - config.headerHeight;
    const marqueeBottom = marqueeTop + marqueeRect.height;

    const startIndex = Math.max(0, Math.floor(marqueeTop / config.itemHeight));
    const endIndex = Math.min(totalItems - 1, Math.floor(marqueeBottom / config.itemHeight));

    if (startIndex > endIndex) return [];
    return Array.from({ length: endIndex - startIndex + 1 }, (_, i) => startIndex + i);
  }

  /**
   * Calculate selected indices by checking DOM element positions against the marquee.
   * Works for grid layouts (tiles view) where items aren't in a linear list.
   * @param container The scrollable container element
   * @param itemSelector CSS selector for item elements
   */
  function getSelectedIndicesFromDOM(container: HTMLElement, itemSelector: string): number[] {
    if (!marqueeRect) return [];

    const containerRect = container.getBoundingClientRect();
    const mLeft = marqueeRect.left + containerRect.left;
    const mTop = marqueeRect.top + containerRect.top;
    const mRight = mLeft + marqueeRect.width;
    const mBottom = mTop + marqueeRect.height;

    const items = container.querySelectorAll(itemSelector);
    const indices: number[] = [];

    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      // Check AABB intersection
      if (rect.right > mLeft && rect.left < mRight && rect.bottom > mTop && rect.top < mBottom) {
        indices.push(i);
      }
    }

    return indices;
  }

  return {
    get isDragging() {
      return isDragging;
    },
    get dragJustEnded() {
      return performance.now() - dragEndTime < DRAG_END_GRACE_MS;
    },
    get ctrlKeyHeld() {
      return ctrlKeyHeld;
    },
    get marqueeRect() {
      return marqueeRect;
    },
    isBackgroundClick,
    start,
    move,
    end,
    getSelectedIndices,
    getSelectedIndicesFromDOM,
  };
}
