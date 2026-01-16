/**
 * Global clipboard state for cross-pane file operations.
 * Issue: tauri-explorer-u7bg
 *
 * This enables copy/cut/paste between dual panes.
 */

import type { FileEntry } from "$lib/domain/file";

export type ClipboardOperation = "copy" | "cut";

export interface ClipboardContent {
  entry: FileEntry;
  operation: ClipboardOperation;
}

function createClipboardStore() {
  let content = $state<ClipboardContent | null>(null);

  return {
    get content() {
      return content;
    },
    get hasContent() {
      return content !== null;
    },
    get isCut() {
      return content?.operation === "cut";
    },

    copy(entry: FileEntry): void {
      content = { entry, operation: "copy" };
    },

    cut(entry: FileEntry): void {
      content = { entry, operation: "cut" };
    },

    clear(): void {
      content = null;
    },

    /**
     * Take the clipboard content (clears cut items, keeps copy items).
     * Returns null if clipboard is empty.
     */
    take(): ClipboardContent | null {
      if (!content) return null;

      const result = content;

      // Clear clipboard for cut operations (can only paste once)
      if (content.operation === "cut") {
        content = null;
      }

      return result;
    },
  };
}

export const clipboardStore = createClipboardStore();
