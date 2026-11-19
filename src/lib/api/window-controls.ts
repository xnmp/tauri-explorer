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

export async function requestBrowserWindowControl(action: WindowControlAction): Promise<void> {
  const { getMockControl } = await import("./mock-control");
  getMockControl().windowControl?.(action);
}
