/**
 * Native OS-level drag for dropping files into external apps (VSCode, browsers, Finder).
 * HTML5 dragstart only reaches in-webview targets — this plugin opens a real OS drag session.
 */

import { startDrag } from "@crabnebula/tauri-plugin-drag";

// 1×1 transparent PNG. The plugin requires a valid image for the drag preview;
// an empty string deserializes to a bogus PathBuf and fails at runtime on some platforms.
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function startExternalDrag(paths: string[], iconPath?: string): Promise<void> {
  if (!isTauri() || paths.length === 0) return;
  try {
    await startDrag({ item: paths, icon: iconPath || TRANSPARENT_PNG });
  } catch (err) {
    console.warn("External drag failed:", err);
  }
}
