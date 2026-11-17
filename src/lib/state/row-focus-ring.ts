/** Whether the keyboard focus ring showed on the last focused file row (#1729).
 *
 * Restore-type row focus (a new tab or split pane's first load, a view layout
 * change) is not a fresh user intent, yet WebKit (WKWebView) treats script
 * focus that follows any key press as `:focus-visible`: after a pointer
 * selection, Ctrl+T drew the full keyboard ring around the new tab's row for a
 * few frames. Restore-type focus therefore requests the ring state the user last
 * saw on a row. Ordinary navigation and keyboard movement keep the browser's own
 * heuristic. Window-global, because the restoring row belongs to a different
 * pane or tab than the recorded one. */

/** The part of an element this records from (an `Element` in the app). */
export interface RingSubject { matches(selector: string): boolean }

export function createRowFocusRing() {
  let shown: boolean | undefined;
  return {
    /** The `focusVisible` a restore should request: the last focused row's
     * ring state, or undefined (leave it to the browser) before any row had
     * focus or where the engine cannot report `:focus-visible`. */
    get shown(): boolean | undefined { return shown; },
    /** Record a row that just received focus. */
    record(row: RingSubject): void {
      try {
        shown = row.matches(":focus-visible");
      } catch {
        shown = undefined;
      }
    },
  };
}

export type RowFocusRing = ReturnType<typeof createRowFocusRing>;

export const rowFocusRing: RowFocusRing = createRowFocusRing();
