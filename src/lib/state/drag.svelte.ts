/**
 * Shared drag state for in-app drag and drop.
 * Issue: tauri-5dq0
 *
 * Uses localStorage as a cross-window communication channel because
 * dataTransfer is unreliable between separate webview contexts in Tauri.
 * All webview windows share the same origin, so they can access the same
 * localStorage.
 */

const STORAGE_KEY = "explorer-drag-data";

export interface DragData {
  path: string;
  name: string;
  kind: string;
}

let current: DragData | null = $state(null);

export const dragState = {
  get current() { return current; },

  start(data: DragData) {
    current = data;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // localStorage may be unavailable in some contexts
    }
  },

  clear() {
    current = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  },

  /** Read drag data from localStorage (cross-window fallback) */
  readCrossWindow(): DragData | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as DragData;
    } catch {
      return null;
    }
  },
};
