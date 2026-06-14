/**
 * Pure navigation history utilities.
 * Manages browser-style forward/back navigation history.
 */

export interface HistoryState {
  history: string[];
  historyIndex: number;
}

/**
 * Push a new path to history, truncating any forward history.
 */
export function pushToHistory(
  currentHistory: string[],
  currentIndex: number,
  newPath: string
): HistoryState {
  const truncatedHistory = currentHistory.slice(0, currentIndex + 1);
  truncatedHistory.push(newPath);
  return {
    history: truncatedHistory,
    historyIndex: truncatedHistory.length - 1,
  };
}

/**
 * Check if back navigation is available.
 */
export function canGoBack(historyIndex: number): boolean {
  return historyIndex > 0;
}

/**
 * Check if forward navigation is available.
 */
export function canGoForward(history: string[], historyIndex: number): boolean {
  return historyIndex < history.length - 1;
}

/**
 * Get the previous path for back navigation.
 */
export function getBackPath(
  history: string[],
  historyIndex: number
): string | null {
  if (!canGoBack(historyIndex)) return null;
  return history[historyIndex - 1];
}

/**
 * Get the next path for forward navigation.
 */
export function getForwardPath(
  history: string[],
  historyIndex: number
): string | null {
  if (!canGoForward(history, historyIndex)) return null;
  return history[historyIndex + 1];
}

// UNC root: matches `\\server\share` or `//server/share`, optionally with
// a trailing path. Captures: server, share, tail (without leading separator).
const UNC_PATH = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/;
const UNC_SHARE_ROOT = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]?$/;
const DRIVE_ROOT = /^[a-zA-Z]:[\\/]?$/;

/**
 * Parse path into breadcrumb segments.
 *
 * Handles:
 * - POSIX paths (`/home/me/hello`)
 * - Windows drive paths (`C:\Users\me\hello` or `C:/Users/me/hello`); the
 *   drive letter becomes the first breadcrumb with path `C:\` so navigating
 *   up from it resolves to the drive root, not a bogus `/C:` POSIX path.
 * - UNC paths (`\\server\share\sub\...`); server+share form a single root
 *   breadcrumb because `\\server` alone is not a navigable filesystem path
 *   on Windows.
 */
export function parseBreadcrumbs(
  path: string
): { name: string; path: string }[] {
  if (!path) return [];

  const unc = path.match(UNC_PATH);
  if (unc) {
    const [, server, share, tail] = unc;
    const root = `\\\\${server}\\${share}`;
    const result: { name: string; path: string }[] = [
      { name: root, path: root },
    ];
    if (tail) {
      let accumulated = root;
      for (const part of tail.split(/[\\/]+/).filter(Boolean)) {
        accumulated = `${accumulated}\\${part}`;
        result.push({ name: part, path: accumulated });
      }
    }
    return result;
  }

  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return [];

  const hasDriveRoot = /^[a-zA-Z]:$/.test(parts[0]);
  const sep = hasDriveRoot ? "\\" : "/";
  const result: { name: string; path: string }[] = [];

  let accumulated = "";
  for (const part of parts) {
    if (!accumulated) {
      accumulated = hasDriveRoot ? `${part}${sep}` : `${sep}${part}`;
    } else {
      accumulated = accumulated.endsWith(sep)
        ? `${accumulated}${part}`
        : `${accumulated}${sep}${part}`;
    }
    result.push({ name: part, path: accumulated });
  }

  return result;
}

/**
 * Get parent path from breadcrumbs. Returns null at filesystem root (POSIX
 * `/`, a Windows drive root like `C:\`, or a UNC share root like
 * `\\server\share`) since those have no navigable parent.
 */
export function getParentPath(
  breadcrumbs: { name: string; path: string }[]
): string | null {
  if (breadcrumbs.length > 1) return breadcrumbs[breadcrumbs.length - 2].path;
  if (breadcrumbs.length === 1) {
    const { path } = breadcrumbs[0];
    if (DRIVE_ROOT.test(path)) return null;
    if (UNC_SHARE_ROOT.test(path)) return null;
    return "/";
  }
  return null;
}
