/**
 * Tracks the last focused window's state in localStorage.
 * Issue: tauri-8gpm
 *
 * When opening a new window (Ctrl+N), it should inherit the path
 * and viewMode from the last focused window — not just the current
 * window's active explorer.
 */

import type { ViewMode } from "./types";

const STORAGE_KEY = "explorer-focused-window";

interface FocusedWindowState {
  path: string;
  viewMode: ViewMode;
}

export function saveFocusedWindowState(path: string, viewMode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ path, viewMode }));
  } catch {
    // localStorage not available
  }
}

export function readFocusedWindowState(): FocusedWindowState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FocusedWindowState;
  } catch {
    return null;
  }
}
