import { flushSync, getAbortSignal, onDestroy, tick, untrack } from "svelte";
import { listColumnRange, listExtent, listRows, listWheelStep, LIST_COLUMN_STRIDE, LIST_COLUMN_WIDTH, LIST_PADDING_X, LIST_PADDING_Y, LIST_SLOT_HEIGHT, type ListCardSpec, type ListPlacement, type ListTopItem } from "$lib/domain/list-column-flow";
import { buildListStructure, cardMaxRows, cardRevealTop, cardWheelConsumes, cardWindow, gripKeyRows, gripRows, sizeListModel, springCardFits, springCardWrapped, springWrapBridges } from "$lib/domain/list-cards";
import { rectDimToCSS } from "$lib/domain/zoom";
import type { PeekRow, PeekRows } from "$lib/domain/folder-peek";

/** One mounted top-level slot: its placement, item and (unless it is the
 * creation row) its header row. */
export interface ListVisibleItem {
  readonly placement: ListPlacement;
  readonly item: ListTopItem;
  readonly header: Extract<PeekRow, { kind: "entry" }> | null;
}
import { dropHover } from "$lib/state/drop-hover";
import { createRafCoalescer } from "$lib/domain/raf-coalesce";

interface ListColumnsDeps {
  /** The pane's peek row model (`explorer.detailRows`): entries, pseudo-rows, creation row. */
  getRows: () => PeekRows;
  /** Remembered card height (visible rows) for an open top-level folder. */
  getPreferredRows: (path: string) => number | undefined;
  /** A drag's temporary peeks (#1242): the cards holding them keep their place,
   * and one that starts the next column is bridged (`springCardFits`). */
  getSpringPaths?: () => readonly string[];
  /** Entries whose slot, and card row, must stay mounted (inline editors). */
  getPinnedPaths: () => readonly string[];
  /** Store a card height chosen with its grip (`explorer.setListCardRows`). */
  commitCardRows?: (path: string, rows: number) => void;
  onviewportscroll?: () => void;
  onlayoutchange?: () => void;
}

/** Card content rows mounted beyond the visible ones, on each side. */
const CARD_OVERSCAN = 2;

/** Horizontal fixed-column virtualization; geometry is committed before paint. */
export function useListColumns(deps: ListColumnsDeps) {
  let viewport: HTMLElement | null = null;
  let width = $state(0), height = $state(0), left = $state(0);
  const rows = $derived(listRows(height));
  // A row-count change re-sizes and re-flows; only a row-model change rebuilds items.
  const structure = $derived(buildListStructure(deps.getRows()));
  const springPaths = $derived(deps.getSpringPaths?.() ?? []);
  const model = $derived(sizeListModel(structure, rows, deps.getPreferredRows, springCardFits(structure, deps.getRows(), springPaths, rows, deps.getPreferredRows)));
  const springBridges = $derived(springWrapBridges(model, springPaths));
  const layout = $derived(model.layout);
  const extent = $derived(listExtent(layout.columns.length));
  const range = $derived(listColumnRange(layout.columns.length, left, width));
  // Primitives: `$derived` compares by identity, so scrolling inside the mounted
  // window leaves these (and everything below) unchanged instead of rebuilding
  // every wrapper per scroll frame.
  const rangeStart = $derived(range.start);
  const rangeEnd = $derived(range.end);
  // Looked up only while an editor is pinned (rare), so a listing costs no
  // per-entry path index.
  const pinnedEntries = $derived.by(() => {
    const paths = deps.getPinnedPaths();
    if (!paths.length) return [];
    const rows = deps.getRows().rows;
    return paths.flatMap(path => {
      const row = rows.find(row => row.kind === "entry" && row.entry.path === path);
      return row?.kind === "entry" ? [row.entryIndex] : [];
    });
  });
  const mountedColumns = $derived.by(() => {
    const columns = new Set(Array.from({ length: rangeEnd - rangeStart }, (_, i) => rangeStart + i));
    // The creation row is the first item whenever it exists.
    if (model.items[0]?.entryIndex === null) columns.add(layout.byIndex[0].column);
    for (const index of pinnedEntries) columns.add(layout.byIndex[model.entryItem[index]].column);
    return [...columns].sort((a, b) => a - b);
  });
  // One object per placement for the layout's lifetime: when sideways scrolling
  // changes the mounted range, slots that stay mounted keep their identity, so
  // the keyed each updates nothing but the columns that enter or leave. A new
  // layout has new placements, so nothing stale can be returned.
  const visibleObjects = new WeakMap<ListPlacement, ListVisibleItem>();
  const visibleItems = $derived.by(() => {
    const peekRows = deps.getRows();
    return mountedColumns.flatMap(column => layout.columns[column]).map(placement => {
      let visible = visibleObjects.get(placement);
      if (!visible) {
        const item = model.items[placement.index];
        const header = item.entryIndex === null ? null : peekRows.rows[peekRows.entryToRow[item.entryIndex]] as ListVisibleItem["header"];
        visible = { placement, item, header };
        visibleObjects.set(placement, visible);
      }
      return visible;
    });
  });

  // Per-card scroll offsets (CSS px). A fine-grained proxy, so one card's scroll
  // re-renders only that card. Kept while its card stays open, even unmounted.
  const cardScroll = $state<Record<string, number>>({});
  const cardScrollTop = (path: string): number => cardScroll[path] ?? 0;
  // A card scroll changes which rows are mounted, like a sideways scroll:
  // FileList's tab stop, the marquee and drop hover follow it after the update.
  const cardScrollWork = createRafCoalescer<void>(() => {
    void tick().then(() => { if (viewport?.isConnected) { deps.onviewportscroll?.(); dropHover.refresh(); } });
  });
  onDestroy(() => cardScrollWork.cancel());
  function setCardScrollTop(path: string, top: number): void {
    const value = Number.isFinite(top) ? Math.max(0, top) : 0;
    if (cardScroll[path] === value) return;
    cardScroll[path] = value;
    cardScrollWork.push();
  }
  // A grip drag previews one card's height without committing the layout.
  let preview = $state.raw<{ path: string; rows: number } | null>(null);
  /** The grip a pointer is dragging. Window listeners own its end, so a card
   * whose column unmounts mid-drag (sideways wheel) still commits or cancels. */
  let grip: { path: string; pointer: number; y: number; rows: number; stop: () => void } | null = null;
  const previewRows = (path: string): number | null => preview?.path === path ? preview.rows : null;
  /** Items covered by a growing grip preview (hidden until release). */
  const covered = $derived.by(() => {
    const hidden = new Set<string>();
    if (!preview) return hidden;
    const index = model.items.findIndex(item => item.card?.path === preview!.path);
    const card = model.items[index]?.card;
    if (!card || preview.rows <= card.visibleRows) return hidden;
    const placement = layout.byIndex[index];
    const end = placement.row + 1 + preview.rows;
    for (const other of layout.columns[placement.column]) {
      if (other.row >= placement.row + placement.slots && other.row < end) hidden.add(model.items[other.index].key);
    }
    return hidden;
  });

  /** Content offsets to mount for a card: its window plus pinned editor rows. */
  function cardOffsets(card: ListCardSpec): number[] {
    const visible = previewRows(card.path) ?? card.visibleRows;
    const { start, end } = cardWindow(card.end - card.start, visible, cardScrollTop(card.path), CARD_OVERSCAN);
    const offsets = Array.from({ length: end - start }, (_, i) => start + i);
    for (const entry of pinnedEntries) {
      const offset = model.entryOffset[entry];
      const item = model.items[model.entryItem[entry]];
      if (item?.card === card && offset >= 0 && (offset < start || offset >= end)) offsets.push(offset);
    }
    return offsets.sort((a, b) => a - b);
  }

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
    untrack(() => {
      clamp();
      const open = new Set(model.items.flatMap(item => item.card ? [item.card.path] : []));
      for (const path of Object.keys(cardScroll)) if (!open.has(path)) delete cardScroll[path];
      // A card closed mid-drag may never deliver its grip's cancel.
      if (grip && !open.has(grip.path)) endGrip(null);
      if (preview && !open.has(preview.path)) preview = null;
    });
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
    let wheelCarry = 0; // sub-pixel remainder; see listWheelStep
    const wheel = (event: WheelEvent) => {
      // A card that can still scroll that way takes the wheel natively first.
      const card = (event.target as Element | null)?.closest?.<HTMLElement>("[data-card-scroll]");
      if (card && element.contains(card) && cardWheelConsumes(event, card.scrollTop, card.scrollHeight - card.clientHeight)) return;
      // The undersized-pane fallback must still make its fourth row reachable.
      if (height < LIST_SLOT_HEIGHT * 4 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
      const max = Math.max(0, element.scrollWidth - element.clientWidth);
      const step = listWheelStep(event, width, wheelCarry, { scrollLeft: element.scrollLeft, max });
      wheelCarry = step.carry;
      if (!step.consume) return;
      event.preventDefault();
      element.scrollLeft += step.apply;
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

  /** Horizontal target for showing a column, or null when already visible. */
  function columnTarget(column: number): number | null {
    if (!viewport) return null;
    const start = LIST_PADDING_X + column * LIST_COLUMN_STRIDE;
    const end = start + LIST_COLUMN_WIDTH;
    const innerLeft = viewport.scrollLeft + LIST_PADDING_X;
    const innerRight = viewport.scrollLeft + viewport.clientWidth - LIST_PADDING_X;
    if (width < LIST_COLUMN_WIDTH || start < innerLeft) return start - LIST_PADDING_X;
    if (end > innerRight) return end - viewport.clientWidth + LIST_PADDING_X;
    return null;
  }

  /** Reveal a top-level item (and, inside a card, content row `offset`). */
  function revealItem(index: number, offset = -1): void {
    if (!viewport || !viewport.getClientRects().length) return;
    const placement = layout.byIndex[index];
    if (!placement) return;
    scrollWork.cancel();
    const target = columnTarget(placement.column);
    if (target !== null) viewport.scrollLeft = target;
    const card = model.items[index].card;
    let row = placement.row;
    if (card && offset >= 0) {
      // Scroll the card first, synchronously, so the row is in its mounted
      // window by the time FileList focuses it.
      const top = cardRevealTop(offset, card.visibleRows, cardScrollTop(card.path));
      setCardScrollTop(card.path, top);
      row = placement.row + 1 + Math.max(0, Math.min(card.visibleRows - 1, Math.round(offset - top / LIST_SLOT_HEIGHT)));
    }
    if (height < LIST_SLOT_HEIGHT * 4) {
      const top = LIST_PADDING_Y + row * LIST_SLOT_HEIGHT;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + LIST_SLOT_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + LIST_SLOT_HEIGHT - viewport.clientHeight;
    }
    left = viewport.scrollLeft;
  }

  function revealEntry(entry: number): void {
    const index = model.entryItem[entry];
    if (index === undefined || index < 0) return;
    revealItem(index, model.entryOffset[entry]);
  }

  /** Bring a just-opened card fully into view (after its motion settles). */
  function revealCard(path: string, smooth: boolean): void {
    const index = model.items.findIndex(item => item.card?.path === path);
    if (!viewport || index < 0 || !viewport.getClientRects().length) return;
    const target = columnTarget(layout.byIndex[index].column);
    if (target === null) return;
    scrollWork.cancel();
    viewport.scrollTo({ left: target, behavior: smooth ? "smooth" : "instant" });
    if (!smooth) left = viewport.scrollLeft;
  }

  function containsEntry(entry: number): boolean {
    const index = model.entryItem[entry];
    const placement = index === undefined || index < 0 ? undefined : layout.byIndex[index];
    if (!placement || !mountedColumns.includes(placement.column)) return false;
    const card = model.items[index].card;
    const offset = model.entryOffset[entry];
    return !card || offset < 0 || cardOffsets(card).includes(offset);
  }

  /** Whether column `column` intersects the scrollport (no overscan). */
  function columnVisible(column: number): boolean {
    const x = column * LIST_COLUMN_STRIDE;
    return x < left + width + LIST_PADDING_X && x + LIST_COLUMN_WIDTH > left - LIST_PADDING_X;
  }

  /** An open card's grip range: whole rows, at most floor(0.7R), and never past
   * the bottom of its column, so a resize never moves the card. */
  function gripRange(path: string) {
    const index = model.items.findIndex(item => item.card?.path === path);
    const card = index < 0 ? null : model.items[index].card;
    if (!card) return null;
    const content = card.end - card.start;
    const limit = layout.rows - layout.byIndex[index].row - 1;
    return { card, content, limit, max: Math.max(1, Math.min(content, cardMaxRows(layout.rows), limit)) };
  }
  function endGrip(clientY: number | null): void {
    const session = grip;
    if (!session) return;
    grip = null;
    session.stop();
    const range = clientY === null ? null : gripRange(session.path);
    preview = null;
    if (range) deps.commitCardRows?.(session.path, gripRows(session.rows, rectDimToCSS(clientY! - session.y), range.content, layout.rows, range.limit));
  }
  /** Start dragging a card's grip; the pointer's travel snaps to whole rows. */
  function beginGrip(path: string, pointer: number, clientY: number): void {
    endGrip(null);
    const range = gripRange(path);
    if (!range) return;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer || !grip) return;
      const current = gripRange(path);
      if (!current) { endGrip(null); return; }
      preview = { path, rows: gripRows(grip.rows, rectDimToCSS(event.clientY - grip.y), current.content, layout.rows, current.limit) };
    };
    const up = (event: PointerEvent) => { if (event.pointerId === pointer) endGrip(event.clientY); };
    // A blur (no pointerId) also ends the drag: the release may never arrive.
    const cancel = (event: Event) => { if ((event as Partial<PointerEvent>).pointerId === undefined || (event as PointerEvent).pointerId === pointer) endGrip(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    grip = { path, pointer, y: clientY, rows: range.card.visibleRows, stop: () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    } };
  }
  onDestroy(() => endGrip(null));
  /** Separator keys on a card's grip; true when the key was the grip's. */
  function gripKey(path: string, key: string): boolean {
    const range = gripRange(path);
    if (!range) return false;
    const next = gripKeyRows(key, range.card.visibleRows, range.content, layout.rows, range.limit);
    if (next === null) return false;
    if (next !== range.card.visibleRows) deps.commitCardRows?.(path, next);
    return true;
  }

  return {
    attach, revealItem, revealEntry, revealCard, containsEntry, columnVisible,
    cardScrollTop, setCardScrollTop, cardOffsets,
    previewRows,
    beginGrip, gripKey,
    /** The grip's largest height for an open card (its aria-valuemax). */
    gripMax: (path: string) => gripRange(path)?.max ?? 1,
    isCovered: (key: string) => covered.has(key),
    get model() { return model; },
    get layout() { return layout; },
    get usableWidth() { return width; },
    get rows() { return rows; },
    get extent() { return extent; },
    get visibleItems() { return visibleItems; },
    /** Regions inside a temporary card that started the next column (#1242). */
    get springBridges() { return springBridges; },
    /** Whether temporary card `path` started the next column. */
    springWrapped: (path: string) => springCardWrapped(springBridges, path),
    get short() { return height < LIST_SLOT_HEIGHT * 4; },
  };
}
