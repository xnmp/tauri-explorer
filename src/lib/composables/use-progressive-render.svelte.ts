/**
 * Progressive rendering composable to avoid UI freeze on large directories.
 *
 * Renders entries in rAF-spaced chunks when the entry count jumps
 * significantly (e.g. navigating into a new directory), while extending the
 * limit immediately for small changes (e.g. a new folder was created) and
 * clamping when entries shrink.
 *
 * The render limit is read via `untrack` inside the effect so that the
 * chunked writes from the rAF loop don't re-trigger the effect (which would
 * otherwise collapse the chunking into a single frame).
 */

import { untrack } from "svelte";

export interface ProgressiveRenderState {
  /** How many entries to render right now */
  limit: number;
  /** Entry count seen on the previous transition */
  prevCount: number;
  /** True when a large jump requires rAF-chunked rendering from scratch */
  chunking: boolean;
}

/**
 * Pure transition: decide the next render limit when the entry count changes.
 * - Shrink (or no change): clamp the limit, never restart chunking.
 * - Small increase (<= one chunk above the previous count): extend immediately.
 * - Large increase (new directory): reset to one chunk and signal chunking.
 */
export function nextProgressiveState(
  prev: Pick<ProgressiveRenderState, "limit" | "prevCount">,
  count: number,
  chunk: number,
): ProgressiveRenderState {
  if (count <= prev.limit) {
    return { limit: count, prevCount: count, chunking: false };
  }
  if (count <= prev.prevCount + chunk) {
    return { limit: count, prevCount: count, chunking: false };
  }
  return { limit: chunk, prevCount: count, chunking: true };
}

export function useProgressiveRender(getCount: () => number, chunk: number) {
  let limit = $state(chunk);
  let rafId: number | null = null;
  let prevCount = 0;

  $effect(() => {
    const count = getCount();

    if (rafId !== null) cancelAnimationFrame(rafId);

    untrack(() => {
      const next = nextProgressiveState({ limit, prevCount }, count, chunk);
      limit = next.limit;
      prevCount = next.prevCount;
      if (!next.chunking) return;

      const renderMore = () => {
        limit = Math.min(limit + chunk, count);
        rafId = limit < count ? requestAnimationFrame(renderMore) : null;
      };
      rafId = requestAnimationFrame(renderMore);
    });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  });

  return {
    get limit() {
      return limit;
    },
  };
}
