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
 * Returns true when the keyboard modifier for "copy on drag" is pressed.
 * macOS uses Option (Alt), other platforms use Ctrl.
 */
export function isCopyModifier(event: DragEvent | MouseEvent | KeyboardEvent): boolean {
  return isMac ? event.altKey : event.ctrlKey;
}
