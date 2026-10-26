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
  /** Fixed Details row height; omitted, it follows the layout theme (#1306). */
  itemHeight?: number;
  backgroundClasses?: string[];
}

const DEFAULT_OPTIONS: Required<Omit<MarqueeOptions, "itemHeight">> = {
  headerHeight: 32,
  backgroundClasses: [
    "file-rows",
    "content",
    "details-view",
    "tiles-view",
    "list-view",
    "tile-row",
    "tile-group",
    "list-row",
    "list-canvas",
    "list-slot",
    "virtual-viewport",
    "virtual-item",
    "virtual-spacer-top",
    "virtual-spacer-bottom",
  ],
};

import { clientToCSSRelative, rectDimToCSS, cssToRect } from "$lib/domain/zoom";
import { layoutStore } from "$lib/state/layout.svelte";

export function useMarqueeSelection(options: MarqueeOptions = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  let isDragging = $state(false);
  // No drag has ended yet: performance.now() starts near 0 at page load, so a
  // 0 here made every click in the first DRAG_END_GRACE_MS a drag release (#1387).
  let dragEndTime = Number.NEGATIVE_INFINITY;
  // The browser dispatches a `click` after the marquee's final mouseup; its
  // delay is engine-dependent (WebKit can exceed any small time window), so
  // suppression is consume-once with a generous expiry, not a fixed grace.
  const DRAG_END_GRACE_MS = 500;
  let suppressNextClick = false;
  let dragStart = $state<{ x: number; y: number } | null>(null);
  let dragCurrent = $state<{ x: number; y: number } | null>(null);
  let ctrlKeyHeld = $state(false);

  // rAF-batched pointer updates: mousemove can fire 200+ Hz, but the rubber-band
  // only needs to repaint at the display refresh rate. Coalescing caps the reactive
  // chain (dragCurrent → marqueeRect → DOM style) to one update per frame.
  let pendingMove: { clientX: number; clientY: number; rect: DOMRect; headerHeight?: number; onFlush?: () => void } | null = null;
  let moveRafId: number | null = null;

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

  function start(event: MouseEvent, containerRect: DOMRect, headerHeight?: number): void {
    if (!isBackgroundClick(event.target as HTMLElement)) return;
    if (event.button !== 0) return; // Only left click

    // Blur any focused element before starting marquee
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    isDragging = true;
    ctrlKeyHeld = event.ctrlKey || event.metaKey;
    const minY = headerHeight ?? config.headerHeight;
    dragStart = {
      x: clientToCSSRelative(event.clientX, containerRect.left),
      y: Math.max(minY, clientToCSSRelative(event.clientY, containerRect.top)),
    };
    dragCurrent = { ...dragStart };

    event.preventDefault();
  }

  function flushPendingMove(): void {
    moveRafId = null;
    if (!pendingMove || !isDragging) {
      pendingMove = null;
      return;
    }
    const { clientX, clientY, rect, headerHeight, onFlush } = pendingMove;
    pendingMove = null;
    const minY = headerHeight ?? config.headerHeight;
    dragCurrent = {
      x: Math.max(0, Math.min(clientToCSSRelative(clientX, rect.left), rectDimToCSS(rect.width))),
      y: Math.max(minY, Math.min(clientToCSSRelative(clientY, rect.top), rectDimToCSS(rect.height))),
    };
    onFlush?.();
  }

  function move(event: MouseEvent, containerRect: DOMRect, headerHeight?: number, onFlush?: () => void): boolean {
    if (!isDragging) return false;

    // Safety net: if mouse button was released but we missed the mouseup
    // (e.g. overlay stopPropagation, native drag hijack, window blur, OS pointer cancel)
    if (event.buttons === 0) {
      end({ commit: false });
      return false;
    }

    pendingMove = {
      clientX: event.clientX,
      clientY: event.clientY,
      rect: containerRect,
      headerHeight,
      onFlush,
    };
    if (moveRafId === null) {
      moveRafId = requestAnimationFrame(flushPendingMove);
    }
    return true;
  }

  function end(options?: { commit?: boolean }): void {
    if (!isDragging) return;

    // A real mouseup COMMITS the last RAF-throttled move: when mouseup beats
    // the next animation frame — reliably so on headless WebKit — the final
    // marquee rect would otherwise be stale and the selection computed empty.
    // An abandoned drag (missed mouseup: blur, pointer cancel, overlay
    // swallow) DISCARDS it instead — applying a phantom update after the
    // interaction died would mutate selection out from under the user.
    if (moveRafId !== null) {
      cancelAnimationFrame(moveRafId);
      if (options?.commit ?? true) {
        flushPendingMove();
      }
    }
    pendingMove = null;

    isDragging = false;
    dragStart = null;
    dragCurrent = null;
    cachedItemRects = null;
    cachedItemIndices = null;
    cachedGeometry = null;
    cachedItemElements = null;
    cachedClipRects = null;
    cachedClipScroll = null;

    // The click that follows this mouseup must not clear the selection the
    // marquee just made — mark it consumed-once (with expiry, in case no
    // click ever arrives, e.g. release outside the window).
    dragEndTime = performance.now();
    suppressNextClick = true;
  }

  /**
   * Calculate indices of items intersecting with the marquee rectangle.
   * @param scrollTop Current scroll position of the container
   * @param totalItems Total number of items in the list
   */
  function getSelectedIndices(scrollTop: number, totalItems: number, headerHeight?: number): number[] {
    const itemHeight = options.itemHeight ?? layoutStore.detailsRowHeight;
    if (!marqueeRect || marqueeRect.width === 0 || marqueeRect.height === 0) return [];

    const marqueeTop = marqueeRect.top + scrollTop - (headerHeight ?? config.headerHeight);
    const marqueeBottom = marqueeTop + marqueeRect.height;

    const startIndex = Math.max(0, Math.floor(marqueeTop / itemHeight));
    const endIndex = Math.min(totalItems - 1, Math.ceil(marqueeBottom / itemHeight) - 1);

    if (startIndex > endIndex) return [];
    return Array.from({ length: endIndex - startIndex + 1 }, (_, i) => startIndex + i);
  }

  /**
   * Calculate selected indices by checking DOM element positions against the marquee.
   * Works for grid layouts (tiles view) where items aren't in a linear list.
   * @param container The container element the marquee rect is relative to
   * @param itemSelector CSS selector for item elements
   * @param scroller The element that actually scrolls the items (defaults to container).
   *   In list/tiles views the inner `.list-view`/`.tiles-view` scrolls, not the container.
   */
  // Reuse rects only while scroll, container geometry and rendered row identities stay unchanged.
  let cachedItemRects: DOMRect[] | null = null;
  // Global entry index for each cached rect. Under virtualization the DOM only
  // holds the visible items, so their NodeList position is NOT the entry index;
  // we read it from data-index (set by EntryCell) instead. Falls back to the
  // NodeList position when the attribute is absent (non-virtualized callers).
  let cachedItemIndices: number[] | null = null;
  let cachedItemElements: HTMLElement[] | null = null;
  // Items inside an inner scroller (a List card, #1240) are also clipped to it,
  // so its overscanned or scrolled-out rows are never selected.
  let cachedClipRects: (DOMRect | null)[] | null = null;
  let cachedClipScroll: number[] | null = null;
  let cachedGeometry: { scrollLeft: number; scrollTop: number; left: number; top: number; width: number; height: number } | null = null;

  function getSelectedIndicesFromDOM(container: HTMLElement, itemSelector: string, scroller?: HTMLElement | null): number[] {
    if (!marqueeRect || marqueeRect.width === 0 || marqueeRect.height === 0) return [];

    const containerRect = container.getBoundingClientRect();
    const scrollEl = scroller ?? container;

    const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    const indices = items.map((item, index) => item.dataset.index !== undefined ? Number(item.dataset.index) : index);
    const geometry = {
      scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop,
      left: containerRect.left, top: containerRect.top,
      width: containerRect.width, height: containerRect.height,
    };
    const geometryChanged = !cachedGeometry ||
      geometry.scrollLeft !== cachedGeometry.scrollLeft || geometry.scrollTop !== cachedGeometry.scrollTop ||
      geometry.left !== cachedGeometry.left || geometry.top !== cachedGeometry.top ||
      geometry.width !== cachedGeometry.width || geometry.height !== cachedGeometry.height;
    const rowsChanged = !cachedItemElements || items.length !== cachedItemElements.length ||
      items.some((item, index) => item !== cachedItemElements![index] || indices[index] !== cachedItemIndices![index]);
    const clips = items.map(item => item.parentElement?.closest<HTMLElement>("[data-marquee-clip]") ?? null);
    const clipScroll = clips.map(clip => clip?.scrollTop ?? 0);
    const clipsScrolled = !cachedClipScroll || clipScroll.some((top, index) => top !== cachedClipScroll![index]);
    if (geometryChanged || rowsChanged || clipsScrolled) {
      // Read the live viewport-space rects after scrolling. CSS scroll deltas
      // cannot be subtracted from zoomed rects, and virtualized rows can remount
      // with different global indices while the pointer remains held.
      cachedItemRects = items.map(item => item.getBoundingClientRect());
      const clipRects = new Map<HTMLElement, DOMRect>();
      cachedClipRects = clips.map(clip => {
        if (!clip) return null;
        if (!clipRects.has(clip)) clipRects.set(clip, clip.getBoundingClientRect());
        return clipRects.get(clip)!;
      });
      cachedClipScroll = clipScroll;
      cachedItemIndices = indices;
      cachedItemElements = items;
      cachedGeometry = geometry;
    }

    // marqueeRect is in CSS space; item rects from getBoundingClientRect() are
    // in viewport space on macOS. Scale marquee to viewport for comparison.
    const scrollRect = scrollEl.getBoundingClientRect();
    const clipLeft = scrollRect.left + cssToRect(scrollEl.clientLeft);
    const clipTop = scrollRect.top + cssToRect(scrollEl.clientTop);
    const clipRight = clipLeft + cssToRect(scrollEl.clientWidth);
    const clipBottom = clipTop + cssToRect(scrollEl.clientHeight);
    const mLeft = cssToRect(marqueeRect.left) + containerRect.left;
    const mTop = cssToRect(marqueeRect.top) + containerRect.top;
    const mRight = mLeft + cssToRect(marqueeRect.width);
    const mBottom = mTop + cssToRect(marqueeRect.height);

    const selected: number[] = [];
    for (let i = 0; i < cachedItemRects!.length; i++) {
      const rect = cachedItemRects![i];
      const inner = cachedClipRects![i];
      const rLeft = Math.max(rect.left, clipLeft, inner?.left ?? -Infinity);
      const rRight = Math.min(rect.right, clipRight, inner?.right ?? Infinity);
      const rTop = Math.max(rect.top, clipTop, inner?.top ?? -Infinity);
      const rBottom = Math.min(rect.bottom, clipBottom, inner?.bottom ?? Infinity);
      if (rRight > rLeft && rBottom > rTop && rRight > mLeft && rLeft < mRight && rBottom > mTop && rTop < mBottom) {
        selected.push(cachedItemIndices![i]);
      }
    }

    return selected;
  }

  return {
    get isDragging() {
      return isDragging;
    },
    get dragJustEnded() {
      return performance.now() - dragEndTime < DRAG_END_GRACE_MS;
    },
    /** True exactly once for the click that follows a marquee drag. */
    consumeDragEndClick(): boolean {
      const suppress = suppressNextClick && performance.now() - dragEndTime < DRAG_END_GRACE_MS;
      suppressNextClick = false;
      return suppress;
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
