/**
 * Shared drag state for in-app drag and drop.
 *
 * Bypasses dataTransfer which is unreliable across browsers/webviews.
 * The drag source sets the data on dragstart, and the drop target reads it.
 */

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
  },

  clear() {
    current = null;
  },
};
