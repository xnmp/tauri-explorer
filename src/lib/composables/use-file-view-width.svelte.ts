/**
 * The width a pane's file view lays out at, committed within ResizeObserver
 * delivery so rows never paint at a stale width (#1061).
 *
 * During a pane creation reveal the frame is held wider than its final bounds
 * (#1703). A probe that subtracts that hold reports the final width, so the
 * view reflows on the reveal's first frame; the hold itself becomes the view's
 * paint-only inset (#1718). Inset and width commit together after entries are
 * measured in their old layout, and the reflow glides them into place.
 */
import { flushSync } from "svelte";
import { PANE_CREATION_EASING, PANE_CREATION_MS } from "$lib/domain/pane-motion";
import { contentHold, reflowEntries, reflowTiming } from "$lib/state/entry-reflow-motion";

export function useFileViewWidth(deps: {
  content: () => HTMLElement | null;
  probe: () => HTMLElement | null;
  /** Any resize of the content box (marquee geometry follows it). */
  onresize: (content: HTMLElement) => void;
}) {
  let width = $state(0);
  let inset = $state(0);

  $effect(() => {
    const content = deps.content(), probe = deps.probe();
    if (!content || !probe) return;
    const observer = new ResizeObserver((entries) => {
      // A held frame releasing resizes only `content`: the inset follows here.
      const next = entries.find((entry) => entry.target === probe)?.contentRect.width ?? width;
      const hold = contentHold(content);
      if (next !== width || hold !== inset) {
        const commit = () => flushSync(() => { width = next; inset = hold; });
        const timing = width > 0 && next > 0 && next !== width
          ? reflowTiming(content, { duration: PANE_CREATION_MS, easing: PANE_CREATION_EASING }) : undefined;
        if (timing) reflowEntries(content, commit, timing);
        else commit();
      }
      deps.onresize(content);
    });
    observer.observe(content);
    observer.observe(probe);
    return () => observer.disconnect();
  });

  return {
    /** Layout width in CSS px (0 while the pane has no box). */
    get width() { return width; },
    /** Paint-only end inset the view's rows leave for a held reveal. */
    get inset() { return inset; },
  };
}
