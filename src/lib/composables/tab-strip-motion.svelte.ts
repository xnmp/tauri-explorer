/**
 * Frame scheduling for the window tab strip's motion (#1734): which tabs the
 * strip lays out, the eases its widths and start use, and whether a reveal
 * glides with a sliding tab. The decisions are `domain/tab-strip-motion.ts`;
 * `WindowTabBar` reports changes and reads the state.
 */
import { untrack } from "svelte";
import { stripStep, type StripTabs } from "$lib/domain/tab-strip-motion";
import { TAB_SLIDE_IN_MS } from "$lib/domain/tab-slide";

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const animationFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export function createTabStripMotion(initial: StripTabs, frames: FrameScheduler = animationFrames) {
  let strip = $state(initial);
  let widthEaseMs = $state(TAB_SLIDE_IN_MS);
  let startEaseMs = $state(0);
  // Read by event handlers only, never rendered.
  let gliding = false;

  return {
    /** The tabs the strip lays out (a sliding tab joins or leaves a frame late). */
    get strip(): StripTabs { return strip; },
    get widthEaseMs(): number { return widthEaseMs; },
    /** The strip start's ease: a sliding tab's, or 0 to move at once. */
    get startEaseMs(): number { return startEaseMs; },
    /** A tab is sliding in or out: reveals glide with it instead of jumping. */
    get gliding(): boolean { return gliding; },

    /** The window's tabs changed. Returns the cancel for a deferred update,
     *  for an effect to return. */
    follow(next: StripTabs): () => void {
      const step = stripStep(untrack(() => strip.count), next);
      widthEaseMs = step.widthEaseMs;
      if (!step.slides) {
        strip = next;
        return () => {};
      }
      startEaseMs = step.widthEaseMs;
      gliding = true;
      const frame = frames.request(() => { strip = next; });
      return () => frames.cancel(frame);
    },
    /** The strip's room or aligned start changed (a window resize): the
     *  start moves there at once. */
    startMovesAtOnce(): void { startEaseMs = 0; },
    /** A tab's slide ended. */
    slideEnded(): void { gliding = false; },
  };
}

export type TabStripMotion = ReturnType<typeof createTabStripMotion>;
