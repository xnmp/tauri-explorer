/**
 * Platform detection utilities.
 * Centralises navigator.platform checks so they aren't duplicated across
 * components, composables, and state modules.
 */

/** Whether the current platform is macOS (or iOS). */
export const isMac: boolean =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

/** Whether the current platform is Windows. */
export const isWindows: boolean =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Win");

/**
 * In-app drag-and-drop strategy, keyed by webview engine:
 *
 * - macOS (WKWebView) and Windows (WebView2): use the mouse-based pointer-drag
 *   path (`use-pointer-drag`). It draws a custom ghost and hit-tests with
 *   `elementFromPoint` — no HTML5 DnD and no OS drag session, so there is no
 *   "cancel" cursor and nothing for the webview/Tauri to intercept. On macOS a
 *   native drag is started only when the cursor exits the window (drag-out); on
 *   Windows even that is skipped (the OLE drag gets intercepted by WebView2).
 * - Linux (WebKitGTK): use HTML5 `draggable` items, which feed Tauri's native
 *   `onDragDropEvent` path for in-app drops.
 */
export const usesPointerDrag: boolean = isMac || isWindows;

/** True on the engine that drives in-app DnD through HTML5 draggable (Linux). */
export const usesHtml5Drag: boolean = !isMac && !isWindows;

/**
 * Returns true when the keyboard modifier for "copy on drag" is pressed.
 * macOS uses Option (Alt), other platforms use Ctrl.
 */
export function isCopyModifier(event: DragEvent | MouseEvent | KeyboardEvent): boolean {
  return isMac ? event.altKey : event.ctrlKey;
}
