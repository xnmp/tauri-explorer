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
 */
export function parseBreadcrumbs(
  path: string
): { name: string; path: string }[] {
  if (!path) return [];

  const parts = path.split(/[/\\]/).filter(Boolean);
  const result: { name: string; path: string }[] = [];

  let accumulated = "";
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : `/${part}`;
    result.push({ name: part, path: accumulated });
  }

  return result;
}

/**
 * Get parent path from breadcrumbs.
 */
export function getParentPath(
  breadcrumbs: { name: string; path: string }[]
): string | null {
  if (breadcrumbs.length > 1) return breadcrumbs[breadcrumbs.length - 2].path;
  if (breadcrumbs.length === 1) return "/";
  return null;
}
