import type { PaneSize } from '$lib/domain/pane-viewport';
import { untrack } from 'svelte';

/** Measure presentation before paint, never through the manager's deferred
 * interaction geometry (#1061). The CSS-filled canvas has no in-flow children:
 * updating absolute pane bounds cannot change its size or cause an RO loop. */
export function usePaneCanvasSize(getCanvas: () => HTMLElement | undefined) {
  let size = $state<PaneSize>({ width: 0, height: 0 });
  $effect(() => {
    const canvas = getCanvas();
    if (!canvas) return;
    const measure = () => {
      const css = getComputedStyle(canvas);
      const width = parseFloat(css.width), height = parseFloat(css.height);
      if (width > 0 && height > 0 && (size.width !== width || size.height !== height)) size = { width, height };
    };
    // Reading computed size here also covers the very first paint, before the
    // first ResizeObserver delivery. Keep the callback synchronous on resize.
    untrack(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  });
  return { get current() { return size; } };
}
