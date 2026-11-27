/**
 * User-facing name of the system trash (#1919): "Recycle Bin" on Windows,
 * "Trash" elsewhere. Pure so both spellings are unit-testable.
 */
import { isWindows } from "./platform";

/** Re-exported so a view can name the location and its label from one import. */
export { isTrashPath } from "./virtual-path";

/** The location's name: "Recycle Bin" on Windows, "Trash" otherwise. */
export function trashName(windows: boolean = isWindows): string {
  return windows ? "Recycle Bin" : "Trash";
}

/** Rewrites "Trash"/"trash" words in a user-visible message for the platform. */
export function trashText(text: string, windows: boolean = isWindows): string {
  if (!windows) return text;
  return text.replace(/\b[Tt]rash\b/g, "Recycle Bin");
}
