/**
 * Whether this page is a foreground window or a parked warm window (#931).
 *
 * A parked warm window is a hidden, fully booted page that waits to be
 * claimed. It must not run background feeds a user can only see once it is
 * shown: on Linux CI such a page wedged (its WebKitWebProcess stopped
 * answering) after #921 gave every page a live drive subscription. Feeds that
 * only matter to a visible window defer their start through this gate, and
 * activation opens it before the window is revealed, so a claimed window
 * never shows the parked page's absent or stale state.
 */

export type WarmMode = "off" | "park" | "measure";

/** The page's warm-window role, read from its launch URL and globals. */
export function warmMode(): WarmMode {
  if (typeof window === "undefined") return "off";
  if ((window as { __WARM_MEASURE__?: boolean }).__WARM_MEASURE__) return "measure";
  if (new URLSearchParams(window.location.search).get("warm") === "1") return "park";
  return "off";
}

type Start = () => Promise<void> | void;

export interface ForegroundGate {
  readonly isForeground: boolean;
  /**
   * Run `start` now in a foreground page, otherwise once the page enters the
   * foreground. The returned function cancels a start that has not run yet;
   * it has no effect afterwards.
   */
  whenForeground(start: Start): () => void;
  /**
   * Enter the foreground, starting every deferred feed. Resolves once each
   * started feed has settled (its failures are its own). Callers that reveal
   * a window must not await it: a feed's first backend read can be slow.
   * Idempotent.
   */
  enterForeground(): Promise<void>;
}

export function createForegroundGate(foreground: boolean): ForegroundGate {
  let open = foreground;
  const deferred = new Set<Start>();
  let entered: Promise<void> | null = foreground ? Promise.resolve() : null;
  const run = (start: Start) => Promise.resolve().then(start);

  return {
    get isForeground() { return open; },
    whenForeground(start) {
      if (open) {
        void run(start).catch((error: unknown) => console.error("Foreground start failed:", error));
        return () => {};
      }
      deferred.add(start);
      return () => { deferred.delete(start); };
    },
    enterForeground() {
      if (entered) return entered;
      open = true;
      const starts = [...deferred];
      deferred.clear();
      entered = Promise.allSettled(starts.map(run)).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") console.error("Foreground start failed:", result.reason);
        }
      });
      return entered;
    },
  };
}

/** This page's gate: closed in a parked or measuring warm window until activated. */
export const pageForeground = createForegroundGate(warmMode() === "off");
