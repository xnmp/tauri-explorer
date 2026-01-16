/**
 * Global context menu state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages context menu visibility and position.
 * Only one context menu can be open at a time.
 */

export interface ContextMenuPosition {
  x: number;
  y: number;
}

function createContextMenuStore() {
  let isOpen = $state(false);
  let position = $state<ContextMenuPosition | null>(null);

  return {
    // Accessors
    get isOpen() {
      return isOpen;
    },
    get position() {
      return position;
    },

    // Actions
    open(x: number, y: number): void {
      position = { x, y };
      isOpen = true;
    },

    close(): void {
      isOpen = false;
      position = null;
    },
  };
}

export const contextMenuStore = createContextMenuStore();
