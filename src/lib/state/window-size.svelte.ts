/**
 * Reactive window inner-size tracker (#467).
 *
 * A single source of truth for "how big is this window right now" so
 * features that need to react to window geometry (currently: preview-pane
 * auto-dock) don't each grow their own resize listener. `+page.svelte` calls
 * `sync()` once on mount and again on every `resize` event; everything else
 * just reads `width`/`height` as plain reactive state.
 *
 * Not SSR-relevant (this is a Tauri desktop app, always client-rendered) but
 * guarded anyway to match the rest of state/ and to stay import-safe from
 * Vitest (jsdom provides `window`, but keep the guard cheap and explicit).
 */

function currentWidth(): number {
  return typeof window !== "undefined" ? window.innerWidth : 0;
}

function currentHeight(): number {
  return typeof window !== "undefined" ? window.innerHeight : 0;
}

function createWindowSizeStore() {
  let width = $state(currentWidth());
  let height = $state(currentHeight());

  /** Re-read `window.innerWidth`/`innerHeight`. Call on mount and on resize. */
  function sync(): void {
    width = currentWidth();
    height = currentHeight();
  }

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    sync,
  };
}

export const windowSizeStore = createWindowSizeStore();
