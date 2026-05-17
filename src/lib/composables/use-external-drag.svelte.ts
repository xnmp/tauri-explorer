/**
 * Native OS-level drag for dropping files into external apps (VSCode, browsers, Finder).
 * HTML5 dragstart only reaches in-webview targets — this plugin opens a real OS drag session.
 */

import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { isWindows } from "$lib/domain/platform";

// 1×1 transparent PNG. The plugin requires a valid image for the drag preview;
// an empty string deserializes to a bogus PathBuf and fails at runtime on some platforms.
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// UNC paths (e.g. \\wsl.localhost\Ubuntu-24.04\...) cannot be turned into a
// valid ITEMIDLIST via the legacy ILCreateFromPathW path that tauri-plugin-drag
// uses on Windows. The plugin then unwraps a None and aborts the whole process
// (drag-2.1.0 platform_impl/windows/mod.rs:370). Skip the native drag for
// these — HTML5 DnD inside the webview still works for in-app drops.
function isUncPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

// ILCreateFromPathW also misbehaves on mixed-separator drive paths like
// `C:\Users\chonw/Downloads\image.jpg` — the call appears to succeed but the
// OLE drag never properly initiates, so the cursor stays a cancel icon and no
// ghost renders. The mix arises because sidebar quick-links join the home dir
// (backslashes) with `"/Downloads"` etc.; normalize at the boundary.
function normalizeForWindowsShell(path: string): string {
  if (isUncPath(path)) return path;
  return path.replace(/\//g, "\\");
}

export async function startExternalDrag(paths: string[], iconPath?: string): Promise<void> {
  if (!isTauri() || paths.length === 0) return;
  if (paths.some(isUncPath)) {
    console.warn("[external-drag] skipping native drag for UNC paths (would panic in tauri-plugin-drag)");
    return;
  }
  const item = isWindows ? paths.map(normalizeForWindowsShell) : paths;
  try {
    await startDrag({ item, icon: iconPath || TRANSPARENT_PNG });
  } catch (err) {
    console.warn("External drag failed:", err);
  }
}
