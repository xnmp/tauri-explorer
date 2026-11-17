/** Whether the keyboard focus ring showed on the last focused file row (#1729).
 *
 * Script focus that restores a row (a new tab, a view layout change) is not a
 * fresh user intent, yet WebKit (WKWebView) treats script focus that follows any
 * key press as `:focus-visible`: after a pointer selection, Ctrl+T drew the full
 * keyboard ring around the new tab's row for a few frames. Restore-type focus
 * therefore requests the ring state the user last saw on a row; ordinary
 * keyboard navigation keeps the browser's own heuristic. Window-global, because
 * the restoring row belongs to a different pane or tab than the recorded one. */

/** The part of an element this records from (an `Element` in the app). */
export interface RingSubject { matches(selector: string): boolean }

export function createRowFocusRing() {
  let shown = false;
  return {
    /** The ring state of the last focused row; false before any row had focus. */
    get shown(): boolean { return shown; },
    /** Record a row that just received focus. */
    record(row: RingSubject): void {
      try {
        shown = row.matches(":focus-visible");
      } catch {
        // An engine without :focus-visible draws no keyboard-only ring.
        shown = false;
      }
    },
  };
}

export type RowFocusRing = ReturnType<typeof createRowFocusRing>;

export const rowFocusRing: RowFocusRing = createRowFocusRing();
