/**
 * Global context menu state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k, tauri-obxi
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages context menu visibility and position.
 * Only one context menu can be open at a time.
 */

import { adjustForZoom } from "$lib/domain/zoom";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

function createContextMenuStore() {
  let isOpen = $state(false);
  let position = $state<ContextMenuPosition | null>(null);
  // Which pane opened the menu. Every ExplorerPane renders a ContextMenu
  // instance against this global store; without ownership, dual-pane mode
  // rendered two identical stacked menus and clicks hit the wrong pane's.
  // $state.raw: the token is compared by identity, and plain $state would
  // wrap it in a proxy that breaks reference equality.
  let owner = $state.raw<object | null>(null);

  return {
    // Accessors
    get isOpen() {
      return isOpen;
    },
    get position() {
      return position;
    },
    get owner() {
      return owner;
    },

    // Actions
    open(x: number, y: number, ownerToken: object | null = null): void {
      position = adjustForZoom(x, y);
      owner = ownerToken;
      isOpen = true;
    },

    close(): void {
      isOpen = false;
      position = null;
      owner = null;
    },
  };
}

export const contextMenuStore = createContextMenuStore();
