/**
 * Composable for dragging files from the app to external applications.
 * Issue: tauri-explorer-cgc
 *
 * Uses @crabnebula/tauri-plugin-drag for native system drag support.
 */

import { startDrag } from "@crabnebula/tauri-plugin-drag";

/**
 * Start a native drag operation for files.
 * This enables dragging files from the app to external apps (file managers, etc).
 *
 * @param paths - Array of absolute file paths to drag
 * @param iconPath - Optional path to preview icon
 */
export async function startExternalDrag(paths: string[], iconPath?: string): Promise<void> {
  try {
    await startDrag({
      item: paths,
      icon: iconPath,
    });
  } catch (err) {
    // May not be available in dev/browser mode
    console.warn("External drag not available:", err);
  }
}

/**
 * Start drag for a single file.
 */
export async function startFileDrag(path: string): Promise<void> {
  return startExternalDrag([path]);
}
