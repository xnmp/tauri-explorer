/**
 * The title bar's window buttons (minimize, maximize, close) for a page with
 * no native window: the browser build, whose backend is the mock. A native
 * window acts on itself (`TitleBar.svelte` calls Tauri's window API); here
 * the request goes to the mock's window stand-in, `MockControl.windowControl`,
 * which does nothing unless someone observes it. The marketing site's
 * embedded demo forwards it to its host page as the `window-control` event.
 *
 * The mock is imported only when a button is pressed, so it never joins the
 * startup bundle, and a native window never loads it.
 */
export type WindowControlAction = "minimize" | "maximize" | "close";

/** True only in the marketing site's demo build (`VITE_SITE_DEMO=1`); folds to false elsewhere. */
export const SITE_DEMO_BUILD = import.meta.env.VITE_SITE_DEMO === "1";

/**
 * Who handles a window button:
 * - `host`: the site demo's host page (the demo has no window of its own);
 * - `close-flow`: the app's own close sequence (`requestWindowClose`: cancel
 *   pane activation, release pane dialogs, save the session), native or in an
 *   ordinary browser build, as before the demo existed;
 * - `native`: the native window's minimize / maximize;
 * - `none`: minimize / maximize in an ordinary browser build.
 */
export type WindowControlRoute = "host" | "close-flow" | "native" | "none";

export function windowControlRoute(
  action: WindowControlAction,
  { nativeWindow, hostOwnsWindow }: { nativeWindow: boolean; hostOwnsWindow: boolean },
): WindowControlRoute {
  if (hostOwnsWindow && !nativeWindow) return "host";
  if (action === "close") return "close-flow";
  return nativeWindow ? "native" : "none";
}

export async function requestBrowserWindowControl(action: WindowControlAction): Promise<void> {
  const { getMockControl } = await import("./mock-control");
  getMockControl().windowControl?.(action);
}
