/**
 * Composable for handling external file drops into the app.
 * Issue: tauri-explorer-gvb
 *
 * Uses Tauri's webview onDragDropEvent API to receive files
 * dropped from external applications (like the system file manager).
 *
 * On macOS, this also handles "self-drops" where the native drag
 * session (started by tauri-plugin-drag) drops back onto the same window.
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface ExternalDropState {
  isDragging: boolean;
  dropPosition: { x: number; y: number } | null;
}

export interface ExternalDropCallbacks {
  onDrop: (paths: string[], position: { x: number; y: number }) => void;
  onOver?: (position: { x: number; y: number }) => void;
  onLeave?: () => void;
}

/**
 * Create external drop handling for the app.
 * Call this once at the app level.
 */
export function useExternalDrop(callbacks: ExternalDropCallbacks) {
  let state = $state<ExternalDropState>({
    isDragging: false,
    dropPosition: null,
  });

  let unlisten: UnlistenFn | null = null;

  async function setup(): Promise<void> {
    try {
      const webview = getCurrentWebview();
      console.debug("[external-drop] registering onDragDropEvent on webview:", webview.label);
      unlisten = await webview.onDragDropEvent((event) => {
        const eventType = event.payload.type;
        console.debug("[external-drop] event:", eventType, event.payload);
        if (eventType === "over") {
          state.isDragging = true;
          state.dropPosition = event.payload.position;
          callbacks.onOver?.(event.payload.position);
        } else if (eventType === "drop") {
          state.isDragging = false;

          const paths = event.payload.paths;
          const position = event.payload.position;

          if (paths && paths.length > 0) {
            callbacks.onDrop(paths, position);
          }

          state.dropPosition = null;
          callbacks.onLeave?.();
        } else {
          state.isDragging = false;
          state.dropPosition = null;
          callbacks.onLeave?.();
        }
      });
      console.debug("[external-drop] registered successfully");
    } catch (err) {
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
