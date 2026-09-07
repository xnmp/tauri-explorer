import { getCurrentWindow } from "@tauri-apps/api/window";
import { formatWindowTitle } from "$lib/domain/tab-title";
import { isWindowPath, normalizeLaunchData } from "$lib/domain/window-input";

interface LaunchContext {
  __LAUNCH_DATA__?: unknown;
  location: { search: string };
}

/**
 * Resolve the home directory consistently in main, child, and warm windows.
 * Rust injects launch data only into the main window; descendants inherit it
 * through the `home` query parameter.
 */
export function resolveLaunchHomePath(
  context: LaunchContext | undefined =
    typeof window === "undefined" ? undefined : window,
): string | undefined {
  const injected = normalizeLaunchData(context?.__LAUNCH_DATA__).home;
  const query = context ? new URLSearchParams(context.location.search).get("home") : null;
  return injected ?? (isWindowPath(query) ? query : undefined);
}

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
