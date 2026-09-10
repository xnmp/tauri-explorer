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

export function planWindowLaunch(search: string, injected: unknown, home?: string): WindowLaunchPlan {
  const params = new URLSearchParams(search);
  const requestedPath = params.get("path");
  const path = isWindowPath(requestedPath) ? requestedPath : undefined;
  const view = params.get("viewMode");
  const { cwd } = normalizeLaunchData(injected);
  const homePath = home ?? "/home";
  const genericCwd = !cwd || cwd === homePath || cwd === "/";
  return {
    homePath,
    initialPath: path ?? cwd ?? homePath,
    skipRestore: path !== undefined,
    overridePath: !path && !genericCwd ? cwd : undefined,
    viewMode: isViewMode(view) ? view : undefined,
  };
}
