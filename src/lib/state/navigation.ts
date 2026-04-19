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

/**
 * Parse path into breadcrumb segments.
 *
 * Handles both POSIX paths (/home/me/hello) and Windows paths with a drive
 * letter root (C:\Users\me\hello or C:/Users/me/hello). On Windows, the drive
 * letter becomes the first breadcrumb with path "C:\\" so navigating up from
 * it resolves to the drive root, not a bogus "/C:" POSIX-style path.
 */
export function parseBreadcrumbs(
  path: string
): { name: string; path: string }[] {
  if (!path) return [];

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
 * Get parent path from breadcrumbs. Returns null at filesystem root (POSIX "/"
 * or a Windows drive root like "C:\\"), since those have no parent to surface.
 */
export function getParentPath(
  breadcrumbs: { name: string; path: string }[]
): string | null {
  if (breadcrumbs.length > 1) return breadcrumbs[breadcrumbs.length - 2].path;
  if (breadcrumbs.length === 1) {
    const { path } = breadcrumbs[0];
    return /^[a-zA-Z]:[\\/]?$/.test(path) ? null : "/";
  }
  return null;
}
