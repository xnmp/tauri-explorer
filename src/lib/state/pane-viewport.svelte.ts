import type { PaneNode } from "$lib/domain/pane-layout";
import { paneGeometry, type PaneSize } from "$lib/domain/pane-viewport";

/** Viewport measurements are window presentation state, never saved ratios. */
export function createPaneViewport(getLayout: () => PaneNode | undefined) {
  let size = $state<PaneSize | undefined>();
  let divider = $state(6);
  const geometry = $derived.by(() => {
    const root = getLayout();
    return root && size ? paneGeometry(root, size, divider) : undefined;
  });
  return {
    get geometry() { return geometry; },
    measure(width: number, height: number, gap: number) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      if (size?.width !== width || size?.height !== height) size = { width, height };
      if (Number.isFinite(gap) && gap >= 0) divider = gap;
    },
  };
}
