/**
 * Global clipboard state for cross-pane file operations.
 * Issue: tauri-explorer-u7bg, tauri-explorer-za55, tauri-explorer-rdra, tauri-explorer-jrfg
 *
 * This enables copy/cut/paste between dual panes and with external apps.
 * Supports multiple files for batch copy/cut/paste operations.
 */

import type { FileEntry } from "$lib/domain/file";
import {
  osClipboardHasFiles,
  osClipboardReadFiles,
  osClipboardWriteFiles,
} from "$lib/api/os-clipboard";

export type ClipboardOperation = "copy" | "cut";

export interface ClipboardContent {
  entries: FileEntry[];
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
    get isCut() {
      return content?.operation === "cut";
    },
    get count() {
      return content?.entries.length ?? 0;
    },

    /**
     * Copy files to clipboard (internal + OS clipboard).
     */
    async copy(entries: FileEntry[]): Promise<void> {
      if (entries.length === 0) return;
      content = { entries, operation: "copy" };
      await osClipboardWriteFiles(entries.map((e) => e.path));
    },

    /**
     * Cut files (internal + OS clipboard as copy).
     */
    async cut(entries: FileEntry[]): Promise<void> {
      if (entries.length === 0) return;
      content = { entries, operation: "cut" };
      await osClipboardWriteFiles(entries.map((e) => e.path));
    },

    clear(): void {
      content = null;
    },

    /**
     * Take the clipboard content (clears cut items, keeps copy items).
     */
    take(): ClipboardContent | null {
      if (!content) return null;
      const result = content;
      if (content.operation === "cut") {
        content = null;
      }
      return result;
    },

    async hasOsFiles(): Promise<boolean> {
      return osClipboardHasFiles();
    },

    async readOsFiles(): Promise<OsClipboardContent | null> {
      const paths = await osClipboardReadFiles();
      if (paths.length === 0) return null;
      return { paths, operation: "copy" };
    },
  };
}

export const clipboardStore = createClipboardStore();
