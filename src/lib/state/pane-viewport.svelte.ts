import type { PaneNode } from "$lib/domain/pane-layout";
import { paneGeometry, paneMinimum, type PaneSize } from "$lib/domain/pane-viewport";

export interface InlineWidthLease { update(width: number): void; dispose(): void }
export type ReserveInlineWidth = () => InlineWidthLease;

/** Viewport measurements are window presentation state, never saved ratios. */
export function createPaneViewport(getLayout: () => PaneNode | undefined) {
  let size = $state<PaneSize | undefined>();
  let divider = $state(6);
  let contributions = $state<ReadonlyMap<symbol, { paneId: string; width: number }>>(new Map());
  const widths = $derived.by(() => {
    const result = new Map<string, number>();
    for (const { paneId, width } of contributions.values()) result.set(paneId, (result.get(paneId) ?? 0) + width);
    return result;
  });
  const geometry = $derived.by(() => {
    const root = getLayout();
    return root && size ? paneGeometry(root, size, divider, widths) : undefined;
  });
  // Rendering sizes the canvas from this, not from `geometry`: the viewport
  // measurement behind `geometry` lands a frame after the viewport changes.
  const minimum = $derived.by(() => {
    const root = getLayout();
    return root ? paneMinimum(root, divider, widths) : undefined;
  });
  return {
    /** Measured placement for reveal, directional focus and divider input. */
    get geometry() { return geometry; },
    /** The workspace canvas's minimum, available before any measurement. */
    get minimum() { return minimum; },
    inlineWidth(paneId: string) { return widths.get(paneId) ?? 0; },
    reserveInlineWidth(paneId: string): InlineWidthLease {
      const token = Symbol();
      let disposed = false;
      function remove() {
        if (!contributions.has(token)) return;
        const next = new Map(contributions); next.delete(token); contributions = next;
      }
      return {
        update(width) {
          if (disposed || !Number.isFinite(width) || width < 0) return;
          if (width === 0) { remove(); return; }
          if (contributions.get(token)?.width === width) return;
          contributions = new Map(contributions).set(token, { paneId, width });
        },
        dispose() { disposed = true; remove(); },
      };
    },
    measure(width: number, height: number, gap: number) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      if (size?.width !== width || size?.height !== height) size = { width, height };
      if (Number.isFinite(gap) && gap >= 0) divider = gap;
    },
  };
}
