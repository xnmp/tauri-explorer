/**
 * Coalesce a high-frequency value stream (scroll positions, pointer moves)
 * into at most one `apply` per animation frame, keeping only the latest
 * value. Events can arrive several times per frame on fast wheels and
 * high-Hz mice; applying each one re-runs reactive work for frames that are
 * never painted.
 */
export interface RafCoalescer<T> {
  /** Record the latest value; schedules a flush if none is pending. */
  push(value: T): void;
  /** Drop any pending value and cancel the scheduled flush (e.g. unmount). */
  cancel(): void;
}

export function createRafCoalescer<T>(apply: (value: T) => void): RafCoalescer<T> {
  let pending: { value: T } | null = null;
  let rafId: number | null = null;

  function flush(): void {
    rafId = null;
    if (pending !== null) {
      const { value } = pending;
      pending = null;
      apply(value);
    }
  }

  return {
    push(value: T): void {
      pending = { value };
      if (rafId === null) {
        rafId = requestAnimationFrame(flush);
      }
    },
    cancel(): void {
      pending = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}
