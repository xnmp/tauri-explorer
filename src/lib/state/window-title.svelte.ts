import { getCurrentWindow } from "@tauri-apps/api/window";
import { formatWindowTitle } from "$lib/domain/tab-title";

/** Set the observable native-window title. Best-effort outside Tauri. */
export async function syncWindowTitle(path: string, homePath?: string): Promise<void> {
  const title = formatWindowTitle(path, homePath);
  // Mirrors the native value in browser/E2E environments and provides an
  // observable integration seam for the page's reactive wiring.
  if (typeof document !== "undefined") document.title = title;
  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    // Browser-only tests/previews have no native window.
  }
}

/**
 * Follow the active explorer's reactive path until the owning page unmounts.
 * An absent path is deliberately ignored so a correctly seeded creation title
 * is never replaced during startup or in picker windows that have no tabs.
 */
export function startWindowTitleSync(
  getActivePath: () => string | undefined,
  homePath?: string,
): () => void {
  return $effect.root(() => {
    $effect(() => {
      const path = getActivePath();
      if (path) void syncWindowTitle(path, homePath);
    });
  });
}
