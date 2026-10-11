/** Pointer focus belongs to the gesture's pane intent, independently of drag
 * acquisition. Never cancel mousedown: HTML5 drag needs its default action. */
export function createPanePointerFocus() {
  let restore: (() => void) | null = null;
  return {
    begin(restoreFocus: (() => void) | null): void { restore = restoreFocus; },
    restore(): boolean {
      if (!restore) return false;
      restore();
      return true;
    },
    end(): void { restore = null; },
  };
}
