/**
 * Shared drag state for in-app drag and drop.
 * Issue: tauri-5dq0
 *
 * Uses localStorage as a cross-window communication channel because
 * dataTransfer is unreliable between separate webview contexts in Tauri.
 * All webview windows share the same origin, so they can access the same
 * localStorage.
 */

import { loadPersisted, savePersisted, removePersisted } from "./persisted";

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
    savePersisted(STORAGE_KEY, data);
  },

  clear() {
    current = null;
    removePersisted(STORAGE_KEY);
  },

  /** Read drag data from localStorage (cross-window fallback) */
  readCrossWindow(): DragData | null {
    return loadPersisted<DragData | null>(STORAGE_KEY, null);
  },
};
