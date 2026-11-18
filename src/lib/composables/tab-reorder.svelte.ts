/**
 * Live drag-reorder for the window tab strip (#1749). A drag captures the
 * tabs' resting slots once; each pointer move resolves the insertion index
 * and every tab's displacement (`domain/tab-reorder.ts`), which the strip
 * renders as `--tab-shift`. Ending it glides each tab from where it showed
 * to where it rests (FLIP). `WindowTabBar` owns when each step runs.
 */
import { tick } from "svelte";
import { reorderShifts, reorderTargetIndex, type TabSlot } from "$lib/domain/tab-reorder";
import { TAB_GAP } from "$lib/domain/tab-strip";
import { clientToCSSRelative, rectDimToCSS } from "$lib/domain/zoom";
import { flipTabs, tabRects, TAB_FLIP_ID } from "./tab-strip-dom";

export function createTabReorder(viewport: () => HTMLElement | undefined, glideMs: () => number) {
  let order: string[] = [];
  let slots: TabSlot[] = [];
  let shown = $state.raw<{ to: number; shifts: Readonly<Record<string, number>> } | null>(null);
  const list = () => viewport()?.querySelector<HTMLElement>(".tab-list") ?? null;
  /** Pointer x in the scroller's content coordinates (CSS px). */
  const contentX = (el: HTMLElement, clientX: number) => clientToCSSRelative(clientX, el.getBoundingClientRect().left) + el.scrollLeft;

  /** Snapshot the strip as it is now, then (after the re-render) glide. */
  function glideFrom(before: Map<string, DOMRect>, el: HTMLElement | null): () => void {
    return () => { if (el) void tick().then(() => flipTabs(el, before, glideMs())); };
  }

  return {
    /** The insertion index shown, or null while no reorder is shown. */
    get to(): number | null { return shown?.to ?? null; },
    /** A tab's displacement (CSS px), or null while no reorder is shown. */
    shift(id: string): number | null { return shown ? (shown.shifts[id] ?? 0) : null; },

    /** Capture the tabs' resting slots, before the drag restyles anything. */
    begin(): void {
      order = [];
      slots = [];
      const el = viewport();
      if (!el) return;
      for (const tab of el.querySelectorAll<HTMLElement>(".tab-list > .tab[data-tab-id]")) {
        // A previous drop's glide still under way would offset the resting box.
        for (const glide of tab.getAnimations?.() ?? []) if (glide.id === TAB_FLIP_ID) glide.finish();
        const rect = tab.getBoundingClientRect();
        order.push(tab.dataset.tabId!);
        slots.push({ left: contentX(el, rect.left), width: rectDimToCSS(rect.width) });
      }
    },

    /** Show `tabId` at the slot under `clientX`; null (off the strip) shows it home. */
    update(tabId: string, clientX: number | null): void {
      const el = viewport();
      const from = order.indexOf(tabId);
      if (!el || from < 0) return;
      const to = clientX === null ? from : reorderTargetIndex(slots, from, contentX(el, clientX));
      if (shown?.to === to) return;
      const shifts = reorderShifts(slots, from, to, TAB_GAP);
      shown = { to, shifts: Object.fromEntries(order.map((id, i) => [id, shifts[i]])) };
    },

    /**
     * End the reorder. Returns the move to make (null when none was shown or
     * the strip changed under the drag: `ids` is its current order) and the
     * glide to run once the strip re-renders; `ghost` is where the dragged
     * tab showed, under the pointer.
     */
    end(tabId: string, ids: readonly string[], ghost: DOMRect | null): { move: { from: number; to: number } | null; glide: () => void } {
      const el = list();
      const before = el ? tabRects(el) : new Map<string, DOMRect>();
      if (ghost) before.set(tabId, ghost);
      const unchanged = ids.length === order.length && ids.every((id, i) => id === order[i]);
      const from = ids.indexOf(tabId);
      const move = shown && unchanged && from >= 0 ? { from, to: shown.to } : null;
      shown = null;
      return { move, glide: glideFrom(before, el) };
    },

    /** Drop the shown reorder; the displaced tabs glide back home. */
    cancel(): void {
      if (!shown) return;
      const el = list();
      const glide = glideFrom(el ? tabRects(el) : new Map(), el);
      shown = null;
      glide();
    },
  };
}
