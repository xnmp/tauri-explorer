/**
 * Pointer-intent tracking for keyboard-driven pickers (Quick Open, Command
 * Palette, content search).
 *
 * These lists are navigated with the arrow keys, but hovering the mouse also
 * selects a row. The problem: a corded mouse on a low-friction surface drifts a
 * pixel or two on its own, which would steal the selection away from the
 * keyboard. This tracker only reports a "real" move once the pointer has
 * travelled a deliberate distance from where it rested when the list last
 * changed (open / keyboard nav / new results) — small jitter is ignored.
 *
 * Usage:
 *   const pointer = usePointerIntent();
 *   // on open:           pointer.arm();
 *   // on close:          pointer.disarm();
 *   // on arrow / results: pointer.reset();
 *   // on mousemove:      pointer.track(e.clientX, e.clientY);
 *   // hover guard:       if (pointer.moved) selectedIndex = index;
 */
export function usePointerIntent(thresholdPx = 6) {
  let moved = $state(false);
  let ready = false;
  let anchor: { x: number; y: number } | null = null;
  let last: { x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Picker opened: ignore movement for a short grace period (the pointer is
   *  wherever it happened to be when the dialog appeared over it). */
  function arm(graceMs = 150): void {
    moved = false;
    ready = false;
    anchor = null;
    last = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      ready = true;
    }, graceMs);
  }

  /** Picker closed: stop the grace timer. */
  function disarm(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** Keyboard navigation or a results change: re-anchor at the current pointer
   *  position so nearby drift can't immediately hijack the new selection. */
  function reset(): void {
    moved = false;
    anchor = last;
  }

  /** Feed a pointer position; flips `moved` once it leaves the deadzone. */
  function track(x: number, y: number): void {
    if (!ready) return;
    if (anchor === null) anchor = { x, y };
    if (!moved) {
      const dx = x - anchor.x;
      const dy = y - anchor.y;
      if (dx * dx + dy * dy > thresholdPx * thresholdPx) moved = true;
    }
    last = { x, y };
  }

  return {
    get moved() {
      return moved;
    },
    arm,
    disarm,
    reset,
    track,
  };
}
