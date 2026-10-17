import { flushSync, getAbortSignal, onDestroy, tick, untrack } from "svelte";
import { columnFlow, listColumnRange, listExtent, listRows, listWheelDelta, LIST_COLUMN_STRIDE, LIST_COLUMN_WIDTH, LIST_PADDING_X, LIST_PADDING_Y, LIST_SLOT_HEIGHT } from "$lib/domain/list-column-flow";
import { dropHover } from "$lib/state/drop-hover";
import type { FileEntry } from "$lib/domain/file";
import { createRafCoalescer } from "$lib/domain/raf-coalesce";

interface ListColumnsDeps {
  getItems: () => readonly FileEntry[];
  getPinnedPaths: () => readonly string[];
  onviewportscroll?: () => void;
  onlayoutchange?: () => void;
  /** Phase 3: an inner card may consume wheel input before the outer List. */
  consumeInnerWheel?: (event: WheelEvent) => boolean;
}

/** Horizontal fixed-column virtualization; geometry is committed before paint. */
export function useListColumns(deps: ListColumnsDeps) {
  let viewport: HTMLElement | null = null;
  let width = $state(0), height = $state(0), left = $state(0);
  const rows = $derived(listRows(height));
  const items = $derived(deps.getItems());
  const layout = $derived(columnFlow(items, rows, () => ({ slots: 1, card: false })));
  const pathIndices = $derived(new Map(items.map((entry, index) => [entry.path, index])));
  const extent = $derived(listExtent(layout.columns.length));
  const range = $derived(listColumnRange(layout.columns.length, left, width));
  const mountedColumns = $derived.by(() => {
    const columns = new Set(Array.from({ length: range.end - range.start }, (_, i) => range.start + i));
    for (const path of deps.getPinnedPaths()) {
      const index = pathIndices.get(path);
      if (index !== undefined) columns.add(layout.byIndex[index].column);
    }
    return [...columns].sort((a, b) => a - b);
  });
  const visibleItems = $derived(mountedColumns.flatMap(column => layout.columns[column]).map(placement => ({ placement, entry: items[placement.index] })));

  const scrollWork = createRafCoalescer<number>(position => {
    left = position;
    void tick().then(() => { if (viewport?.isConnected) { deps.onviewportscroll?.(); dropHover.refresh(); } });
  });
  onDestroy(() => scrollWork.cancel());

  function clamp(): void {
    if (!viewport || !viewport.getClientRects().length || viewport.clientWidth <= 0) return;
    const max = Math.max(0, extent - viewport.clientWidth);
    viewport.scrollLeft = Math.max(0, Math.min(viewport.scrollLeft, max));
    left = viewport.scrollLeft;
  }

  $effect(() => {
    void layout;
    void width;
    void height;
    const signal = getAbortSignal();
    untrack(clamp);
    void tick().then(() => {
      if (!signal.aborted && viewport?.isConnected && viewport.getClientRects().length) {
        deps.onviewportscroll?.();
        dropHover.refresh();
        deps.onlayoutchange?.();
      }
    });
  });

  function attach(element: HTMLElement) {
    viewport = element;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return; // retained tab
      scrollWork.cancel();
      flushSync(() => { height = entry.contentRect.height; });
      // The short-pane policy can introduce a vertical scrollbar. Read its
      // actual content width after that CSS change, in this same delivery.
      // A zero-height, normal-flow probe preserves fractional CSS pixels.
      const probe = element.querySelector<HTMLElement>(".list-measure")!;
      flushSync(() => { width = parseFloat(getComputedStyle(probe).width); });
      clamp();
    });
    // Changing overflow changes the content box, but never the CSS-sized
    // border box. Observing that box avoids a same-depth RO feedback loop.
    observer.observe(element, { box: "border-box" });
    const scroll = () => scrollWork.push(element.scrollLeft);
    const wheel = (event: WheelEvent) => {
      const delta = listWheelDelta(event, width);
      if (delta === null || deps.consumeInnerWheel?.(event)) return;
      // The undersized-pane fallback must still make its fourth row reachable.
      if (height < LIST_SLOT_HEIGHT * 4 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
      event.preventDefault();
      element.scrollLeft += delta;
    };
    element.addEventListener("scroll", scroll);
    element.addEventListener("wheel", wheel, { passive: false });
    return { destroy() {
      observer.disconnect();
      scrollWork.cancel();
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("wheel", wheel);
      viewport = null;
    } };
  }

  function reveal(index: number): void {
    if (!viewport || !viewport.getClientRects().length) return;
    const placement = layout.byIndex[index];
    if (!placement) return;
    scrollWork.cancel();
    const start = LIST_PADDING_X + placement.column * LIST_COLUMN_STRIDE;
    const end = start + LIST_COLUMN_WIDTH;
    const innerLeft = viewport.scrollLeft + LIST_PADDING_X;
    const innerRight = viewport.scrollLeft + viewport.clientWidth - LIST_PADDING_X;
    if (width < LIST_COLUMN_WIDTH) viewport.scrollLeft = start - LIST_PADDING_X;
    else if (start < innerLeft) viewport.scrollLeft = start - LIST_PADDING_X;
    else if (end > innerRight) viewport.scrollLeft = end - viewport.clientWidth + LIST_PADDING_X;
    if (height < LIST_SLOT_HEIGHT * 4) {
      const top = LIST_PADDING_Y + placement.row * LIST_SLOT_HEIGHT;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + LIST_SLOT_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + LIST_SLOT_HEIGHT - viewport.clientHeight;
    }
    left = viewport.scrollLeft;
  }

  return {
    attach, reveal,
    containsIndex: (index: number) => !!layout.byIndex[index] && mountedColumns.includes(layout.byIndex[index].column),
    get layout() { return layout; },
    get usableWidth() { return width; },
    get rows() { return rows; },
    get extent() { return extent; },
    get visibleItems() { return visibleItems; },
    get short() { return height < LIST_SLOT_HEIGHT * 4; },
  };
}
