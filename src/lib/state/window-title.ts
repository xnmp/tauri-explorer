import { getCurrentWindow } from "@tauri-apps/api/window";
import { formatWindowTitle } from "$lib/domain/tab-title";

/** Set the observable native-window title. Best-effort outside Tauri. */
export async function syncWindowTitle(path: string, homePath?: string): Promise<void> {
  try {
    await getCurrentWindow().setTitle(formatWindowTitle(path, homePath));
  } catch {
    // Browser-only tests/previews have no native window.
  }
}
