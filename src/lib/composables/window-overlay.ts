/**
 * Full-window overlays opened from inside the window body (#1859).
 *
 * `.main-content` is a stacking context below the title bar (Floating Islands
 * lifts the bar over its islands; the active tab is lifted in every layout)
 * and the status bar. A dialog or a menu's dismissing backdrop mounted inside
 * it cannot paint above them, so they stayed sharp and took clicks through
 * the overlay. While any such overlay is mounted, the document root carries
 * `data-window-overlay-open` and `+page.svelte` raises `.main-content` above
 * them, as it does for a fullscreen preview.
 *
 * Explicit state rather than a `:has()` selector: WebKit re-evaluates `:has()`
 * on every mutation inside the window body (about 7% slower tab switching and
 * scrolling in a 5000-entry folder).
 */

export const WINDOW_OVERLAY_ATTRIBUTE = "data-window-overlay-open";

let held = 0;

function publish(root: HTMLElement): void {
  root.toggleAttribute(WINDOW_OVERLAY_ATTRIBUTE, held > 0);
}

/**
 * Svelte action for an overlay's full-window root. `active` false (a
 * pane-scoped modal, which stays inside its pane) holds nothing.
 */
export function windowOverlay(node: HTMLElement, active = true) {
  const root = node.ownerDocument.documentElement;
  let holding = false;
  const hold = (on: boolean) => {
    if (on === holding) return;
    holding = on;
    held += on ? 1 : -1;
    publish(root);
  };
  hold(active);
  return {
    update: (next = true) => hold(next),
    destroy: () => hold(false),
  };
}
