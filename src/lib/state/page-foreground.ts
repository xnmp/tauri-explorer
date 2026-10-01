/**
 * Whether this page is a foreground window or a parked warm window: the one
 * foreground notion every page-lifetime service consults.
 *
 * A parked warm window is a hidden, fully booted page that may wait for the
 * app's whole lifetime to be claimed. Work that only a visible window needs
 * starts through this gate, which a parked or measuring page opens only once
 * its activation has committed. Before the gate, a parked page ran its own
 * drive feed for its whole life: a PowerShell enumeration every 1.5 s on
 * Windows, a 1.5 s poll and a `/Volumes` watch on macOS, and a 30 s poll plus
 * evaluated `drives-changed` pushes on Linux. File-operation recovery is the
 * other consumer: a page that may still be retired must not claim it.
 *
 * Deferred work starts after the window is already shown. A claimed window
 * therefore shows the drive list it read while parked until its activation
 * re-read lands, which takes seconds on Windows (#931).
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
  // Synchronous, so a start runs before anything can stop its owner.
  const run = (start: Start) => new Promise<void>((resolve) => resolve(start()));

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

/** This page's gate: closed in a parked or measuring warm window until its activation commits. */
export const pageForeground = createForegroundGate(warmMode() === "off");
