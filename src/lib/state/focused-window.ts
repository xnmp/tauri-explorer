/**
 * Tracks the last focused window's state in localStorage.
 * Issue: tauri-8gpm
 *
 * When opening a new window (Ctrl+N), it should inherit the path
 * and viewMode from the last focused window — not just the current
 * window's active explorer.
 */

import type { ViewMode } from "./types";
import { loadPersisted, savePersisted } from "./persisted";

const STORAGE_KEY = "explorer-focused-window";

interface FocusedWindowState {
  path: string;
  viewMode: ViewMode;
}

export function saveFocusedWindowState(path: string, viewMode: ViewMode): void {
  savePersisted(STORAGE_KEY, { path, viewMode });
}

export function readFocusedWindowState(): FocusedWindowState | null {
  return loadPersisted<FocusedWindowState | null>(STORAGE_KEY, null);
}
