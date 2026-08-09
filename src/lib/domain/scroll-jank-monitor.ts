/**
 * Frame-gap monitor for diagnosing scroll jank (#593).
 *
 * Samples requestAnimationFrame timestamps while active and reports how many
 * frames exceeded the long-frame threshold. Pure domain logic: rAF/cancel are
 * injected so tests can drive synthetic frame timelines.
 */

export interface ScrollJankReport {
  /** Total frames observed (gaps measured between consecutive frames). */
  frames: number;
  /** Frames whose gap from the previous frame exceeded `longFrameMs`. */
  longFrames: number;
  /** Worst single frame gap in ms. */
  worstFrameMs: number;
  /** Wall-clock span of the sample in ms. */
  durationMs: number;
}

export interface ScrollJankMonitorOptions {
  /** Gap above which a frame counts as long. Default 32ms (missed vsync ×2). */
  longFrameMs?: number;
  raf?: (cb: (ts: number) => void) => number;
  caf?: (id: number) => void;
}

export interface ScrollJankMonitor {
  /** Begin sampling. No-op if already running. */
  start(): void;
  /** Stop sampling and return the report, or null if never started. */
  stop(): ScrollJankReport | null;
  readonly running: boolean;
}

export function createScrollJankMonitor(
  options: ScrollJankMonitorOptions = {},
): ScrollJankMonitor {
  const longFrameMs = options.longFrameMs ?? 32;
  const raf = options.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = options.caf ?? ((id) => cancelAnimationFrame(id));

  let rafId: number | null = null;
  let lastTs: number | null = null;
  let firstTs: number | null = null;
  let frames = 0;
  let longFrames = 0;
  let worstFrameMs = 0;

  function tick(ts: number) {
    if (lastTs !== null) {
      const gap = ts - lastTs;
      frames++;
      if (gap > longFrameMs) longFrames++;
      if (gap > worstFrameMs) worstFrameMs = gap;
    } else {
      firstTs = ts;
    }
    lastTs = ts;
    rafId = raf(tick);
  }

  return {
    get running() {
      return rafId !== null;
    },
    start() {
      if (rafId !== null) return;
      lastTs = null;
      firstTs = null;
      frames = 0;
      longFrames = 0;
      worstFrameMs = 0;
      rafId = raf(tick);
    },
    stop() {
      if (rafId === null) return null;
      caf(rafId);
      rafId = null;
      return {
        frames,
        longFrames,
        worstFrameMs,
        durationMs: lastTs !== null && firstTs !== null ? lastTs - firstTs : 0,
      };
    },
  };
}
