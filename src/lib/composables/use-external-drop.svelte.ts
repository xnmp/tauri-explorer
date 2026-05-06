/**
 * Composable for handling external file drops into the app.
 * Issue: tauri-explorer-gvb
 *
 * Uses global Tauri event listeners (not webview-scoped onDragDropEvent)
 * to receive native drops from external applications (Finder, etc.).
 *
 * Global listen is required because webview-scoped onDragDropEvent does NOT
 * fire for child windows created via the JS WebviewWindow API (Tauri v2 bug).
 * Global listen("tauri://drag-*") receives events on ALL windows reliably.
 */

import { listen, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";

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

  let unlistenOver: UnlistenFn | null = null;
  let unlistenDrop: UnlistenFn | null = null;
  let unlistenLeave: UnlistenFn | null = null;

  async function setup(): Promise<void> {
    try {
      console.debug("[external-drop] registering global drag-drop listeners");

      unlistenOver = await listen<{ position: { x: number; y: number } }>(
        TauriEvent.DRAG_OVER,
        (event) => {
          state.isDragging = true;
          state.dropPosition = event.payload.position;
          callbacks.onOver?.(event.payload.position);
        },
      );

      unlistenDrop = await listen<{ paths: string[]; position: { x: number; y: number } }>(
        TauriEvent.DRAG_DROP,
        (event) => {
          console.debug("[external-drop] drop event:", event.payload);
          state.isDragging = false;

          const paths = event.payload.paths;
          const position = event.payload.position;

          if (paths && paths.length > 0) {
            callbacks.onDrop(paths, position);
          }

          state.dropPosition = null;
          callbacks.onLeave?.();
        },
      );

      unlistenLeave = await listen(TauriEvent.DRAG_LEAVE, () => {
        state.isDragging = false;
        state.dropPosition = null;
        callbacks.onLeave?.();
      });

      console.debug("[external-drop] registered successfully");
    } catch (err) {
      console.warn("External drop not available:", err);
    }
  }

  function cleanup(): void {
    unlistenOver?.();
    unlistenDrop?.();
    unlistenLeave?.();
    unlistenOver = null;
    unlistenDrop = null;
    unlistenLeave = null;
  }

  return {
    get state() {
      return state;
    },
    setup,
    cleanup,
  };
}
