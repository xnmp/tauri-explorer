/** Decide initial navigation without reading browser state or starting work. */
import { isViewMode, type ViewMode } from "./file";
import { isWindowPath, normalizeLaunchData } from "./window-input";

export interface WindowLaunchPlan {
  homePath: string;
  initialPath: string;
  skipRestore: boolean;
  overridePath?: string;
  viewMode?: ViewMode;
}

/**
 * Query marker the native layer adds when it reloads a window whose renderer
 * process terminated (`src-tauri/src/renderer_owner/reload.rs`, #942). The
 * replacement document belongs to a window that already had a session.
 */
export const RENDERER_RECOVERY_PARAM = "rendererRecovery";

export function isRendererRecovery(search: string): boolean {
  return new URLSearchParams(search).get(RENDERER_RECOVERY_PARAM) === "1";
}

/**
 * A one-shot startup request carried in the launch URL (warm parking, address
 * bar focus). A recovered document must not replay it: the document that was
 * lost already served it.
 */
export function launchRequest(search: string, name: string): string | null {
  return isRendererRecovery(search) ? null : new URLSearchParams(search).get(name);
}

export function planWindowLaunch(search: string, injected: unknown, home?: string): WindowLaunchPlan {
  const params = new URLSearchParams(search);
  const requestedPath = params.get("path");
  const path = isWindowPath(requestedPath) ? requestedPath : undefined;
  const view = params.get("viewMode");
  const { cwd } = normalizeLaunchData(injected);
  const homePath = home ?? "/home";
  if (isRendererRecovery(search)) {
    // Restore the window's own persisted tabs; the launch path is only the
    // fallback for a window that had not saved any yet.
    return { homePath, initialPath: path ?? cwd ?? homePath, skipRestore: false, overridePath: undefined, viewMode: undefined };
  }
  const genericCwd = !cwd || cwd === homePath || cwd === "/";
  return {
    homePath,
    initialPath: path ?? cwd ?? homePath,
    skipRestore: path !== undefined,
    overridePath: !path && !genericCwd ? cwd : undefined,
    viewMode: isViewMode(view) ? view : undefined,
  };
}
