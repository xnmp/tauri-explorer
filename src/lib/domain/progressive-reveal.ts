/**
 * Reveals a lazily rendered document a slice at a time, one slice per frame
 * (#1418).
 *
 * A math-heavy Markdown preview is ~600 KB of KaTeX HTML. Typesetting it and
 * then laying it out in one task held the main thread for 150–300 ms, so an
 * arrow key pressed meanwhile (and the selection it moves) waited for the
 * whole preview. Here no work starts until the frame after the request (the
 * selection paints first), each slice is bounded by time and by HTML size
 * (a proxy for the layout it will cost), and a request that stops being
 * current stops at the next slice boundary without showing anything more.
 *
 * Pure: the clock and the frame boundary are injected.
 */

export interface FrameScheduler {
  now(): number;
  /** Resolves after the next rendered frame (or a bounded fallback). */
  nextFrame(): Promise<void>;
}

export interface RevealLimits {
  /** Main-thread time spent producing one slice. */
  readonly sliceMs: number;
  /** HTML characters shown per slice; layout cost grows with it. */
  readonly sliceChars: number;
}

/** ~48 KB of KaTeX HTML lays out in about 10–20 ms in WebKit. */
export const PREVIEW_REVEAL_LIMITS: RevealLimits = { sliceMs: 8, sliceChars: 48_000 };

/**
 * Pulls `source` slice by slice. Every slice but the last is passed to `show`
 * (all blocks so far); the complete block list is returned for the caller to
 * publish. Returns null, without pulling further, once `isCurrent()` is false.
 * Errors from `source` propagate.
 */
export async function revealProgressively(
  source: Iterable<string>,
  isCurrent: () => boolean,
  show: (blocks: readonly string[]) => void,
  scheduler: FrameScheduler,
  limits: RevealLimits = PREVIEW_REVEAL_LIMITS,
): Promise<readonly string[] | null> {
  const iterator = source[Symbol.iterator]();
  const blocks: string[] = [];
  for (;;) {
    await scheduler.nextFrame();
    if (!isCurrent()) return null;
    const start = scheduler.now();
    let chars = 0;
    do {
      const next = iterator.next();
      if (next.done) return blocks;
      blocks.push(next.value);
      chars += next.value.length;
    } while (scheduler.now() - start < limits.sliceMs && chars < limits.sliceChars);
    show([...blocks]);
  }
}
