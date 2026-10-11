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
import type { NativeFileDragEvent } from "$lib/api/native-file-drag";
import type { DragData } from "$lib/state/drag.svelte";

export interface ExternalDropState {
  isDragging: boolean;
  dropPosition: { x: number; y: number } | null;
}

export interface ExternalDropCallbacks {
  onDrop: (paths: string[], position: { x: number; y: number }, source?: DragData | null, copyModifier?: boolean | null) => void | Promise<void>;
  onEnter?: (paths: string[], position: { x: number; y: number }, source?: DragData | null, copyModifier?: boolean | null) => void;
  onOver?: (position: { x: number; y: number }, copyModifier?: boolean | null) => void;
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
  // Guards against cleanup() racing the async listener registration:
  // if cleanup runs before registration resolves, unlisten on arrival.
  let generation = 0;

  async function setup(): Promise<void> {
    const owner = ++generation;
    unlisten?.();
    unlisten = null;
    try {
      const webview = getCurrentWebview();
      const fn = await webview.listen<NativeFileDragEvent>("explorer-native-file-drag", (event) => {
        if (owner !== generation) return;
        const eventType = event.payload.type;
        if (eventType === "over" || eventType === "enter") {
          state.isDragging = true;
          state.dropPosition = event.payload.position;
          if (eventType === "enter") callbacks.onEnter?.(event.payload.paths, event.payload.position, event.payload.source, event.payload.copyModifier);
          callbacks.onOver?.(event.payload.position, event.payload.copyModifier);
        } else if (eventType === "drop") {
          state.isDragging = false;

          const paths = event.payload.paths;
          const position = event.payload.position;

          state.dropPosition = null;
          // Drop routing owns cleanup in finally. A leave callback here would
          // erase feedback for a gesture started by a synchronous consumer.
          void callbacks.onDrop(paths, position, event.payload.source, event.payload.copyModifier);
        } else {
          state.isDragging = false;
          state.dropPosition = null;
          callbacks.onLeave?.();
        }
      });
      if (owner !== generation) {
        fn();
        return;
      }
      unlisten = fn;
    } catch (err) {
      // Expected when running outside Tauri (dev server, tests)
    }
  }

  function cleanup(): void {
    generation++;
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
