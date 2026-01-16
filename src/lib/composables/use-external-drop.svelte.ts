/**
 * Composable for handling external file drops into the app.
 * Issue: tauri-explorer-gvb
 *
 * Uses Tauri's webview onDragDropEvent API to receive files
 * dropped from external applications (like the system file manager).
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface ExternalDropState {
  isDragging: boolean;
  dropPosition: { x: number; y: number } | null;
}

export type DropHandler = (paths: string[], position: { x: number; y: number }) => void;

/**
 * Create external drop handling for the app.
 * Call this once at the app level.
 */
export function useExternalDrop(onDrop: DropHandler) {
  let state = $state<ExternalDropState>({
    isDragging: false,
    dropPosition: null,
  });

  let unlisten: UnlistenFn | null = null;

  async function setup(): Promise<void> {
    try {
      const webview = getCurrentWebview();
      unlisten = await webview.onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          state.isDragging = true;
          state.dropPosition = event.payload.position;
        } else if (event.payload.type === "drop") {
          state.isDragging = false;

          const paths = event.payload.paths;
          const position = event.payload.position;

          if (paths && paths.length > 0) {
            onDrop(paths, position);
          }

          state.dropPosition = null;
        } else if (event.payload.type === "cancelled") {
          state.isDragging = false;
          state.dropPosition = null;
        }
      });
    } catch (err) {
      // WebView API may not be available in dev/browser mode
      console.warn("External drop not available:", err);
    }
  }

  function cleanup(): void {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  return {
    get state() {
      return state;
    },
    setup,
    cleanup,
  };
}
