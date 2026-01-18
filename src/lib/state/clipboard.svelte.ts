/**
 * Global clipboard state for cross-pane file operations.
 * Issue: tauri-explorer-u7bg, tauri-explorer-za55, tauri-explorer-rdra
 *
 * This enables copy/cut/paste between dual panes and with external apps.
 * Now integrates with the OS clipboard for copying files to/from
 * other applications like Windows Explorer, macOS Finder, etc.
 */

import type { FileEntry } from "$lib/domain/file";
import {
  osClipboardHasFiles,
  osClipboardReadFiles,
  osClipboardWriteFiles,
} from "$lib/api/os-clipboard";

export type ClipboardOperation = "copy" | "cut";

export interface ClipboardContent {
  entry: FileEntry;
  operation: ClipboardOperation;
}

/** Content from OS clipboard (external apps). */
export interface OsClipboardContent {
  paths: string[];
  operation: "copy"; // External sources are always copy
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

    /**
     * Copy a file to clipboard (internal + OS clipboard).
     */
    async copy(entry: FileEntry): Promise<void> {
      content = { entry, operation: "copy" };
      // Also write to OS clipboard for external app paste
      await osClipboardWriteFiles([entry.path]);
    },

    /**
     * Cut a file (internal only - OS clipboard doesn't support cut).
     */
    async cut(entry: FileEntry): Promise<void> {
      content = { entry, operation: "cut" };
      // Write to OS clipboard as copy (cut is app-specific behavior)
      await osClipboardWriteFiles([entry.path]);
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

    /**
     * Check if OS clipboard has files from external sources.
     */
    async hasOsFiles(): Promise<boolean> {
      return osClipboardHasFiles();
    },

    /**
     * Read files from OS clipboard (from external apps).
     * Returns paths of files copied in external apps.
     */
    async readOsFiles(): Promise<OsClipboardContent | null> {
      const paths = await osClipboardReadFiles();
      if (paths.length === 0) return null;
      return { paths, operation: "copy" };
    },
  };
}

export const clipboardStore = createClipboardStore();
