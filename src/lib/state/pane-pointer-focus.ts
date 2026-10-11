/** Pointer focus belongs to the gesture's pane intent, independently of drag
 * acquisition. Never cancel mousedown, and never move focus during it: HTML5
 * drag needs mousedown's default action, and Chromium abandons the drag when
 * focus is moved while the button is still down. The previous owner gets focus
 * back on release instead. */
export function createPanePointerFocus() {
  let restore: (() => void) | null = null;
  return {
    begin(restoreFocus: (() => void) | null): void { restore = restoreFocus; },
    /** True while a gesture that must not activate its pane is in progress. */
    get active(): boolean { return restore !== null; },
    /** Runs the pending restore, then ends the gesture. The gesture stays
     * active while restoring so the `focusin` the restore causes cannot
     * activate whichever pane receives focus. Returns whether one was pending. */
    release(): boolean {
      const pending = restore;
      if (!pending) return false;
      try { pending(); } finally { restore = null; }
      return true;
    },
    end(): void { restore = null; },
  };
}

export interface Focusable { focus(options?: FocusOptions): void }

/** Focuses the first candidate that actually takes focus. A candidate can be
 * gone, hidden or unfocusable (or `document.body`), in which case `focus()`
 * silently does nothing, so success is judged by where focus landed. */
export function focusFirstAccepting(
  candidates: readonly (Focusable | null | undefined)[],
  currentFocus: () => unknown,
): boolean {
  for (const candidate of candidates) {
    if (!candidate) continue;
    candidate.focus({ preventScroll: true });
    if (currentFocus() === candidate) return true;
  }
  return false;
}
