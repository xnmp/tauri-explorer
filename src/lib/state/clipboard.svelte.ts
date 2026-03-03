/**
 * Global clipboard state for cross-pane and cross-window file operations.
 * Issue: tauri-explorer-u7bg, tauri-explorer-za55, tauri-explorer-rdra, tauri-explorer-jrfg, tauri-anov
 *
 * This enables copy/cut/paste between dual panes, across windows, and with external apps.
 * Supports multiple files for batch copy/cut/paste operations.
 *
 * Cross-window sync: Uses Tauri's inter-window event system to broadcast
 * clipboard changes so cut/copy in one window is available for paste in another.
 */

import type { FileEntry } from "$lib/domain/file";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
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

const CLIPBOARD_EVENT = "app://clipboard-sync";

function createClipboardStore() {
  let content = $state<ClipboardContent | null>(null);
  let unlisten: UnlistenFn | null = null;

  // Broadcast clipboard content to all windows
  async function broadcast(data: ClipboardContent | null): Promise<void> {
    try {
      await emit(CLIPBOARD_EVENT, data);
    } catch {
      // Emit may fail if not running in Tauri (e.g., dev browser)
    }
  }

  // Listen for clipboard changes from other windows
  async function startListening(): Promise<void> {
    try {
      unlisten = await listen<ClipboardContent | null>(CLIPBOARD_EVENT, (event) => {
        // Update local state from the event (avoids infinite loop since
        // the emitting window already has the correct state)
        content = event.payload;
      });
    } catch {
      // Listen may fail if not running in Tauri
    }
  }

  // Start listening immediately
  startListening();

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
     * Copy files to clipboard (internal + OS clipboard + broadcast).
     */
    async copy(entries: FileEntry[]): Promise<void> {
      if (entries.length === 0) return;
      content = { entries, operation: "copy" };
      await Promise.all([
        osClipboardWriteFiles(entries.map((e) => e.path)),
        broadcast(content),
      ]);
    },

    /**
     * Cut files (internal + OS clipboard + broadcast).
     */
    async cut(entries: FileEntry[]): Promise<void> {
      if (entries.length === 0) return;
      content = { entries, operation: "cut" };
      await Promise.all([
        osClipboardWriteFiles(entries.map((e) => e.path)),
        broadcast(content),
      ]);
    },

    clear(): void {
      content = null;
      broadcast(null);
    },

    /**
     * Take the clipboard content (clears cut items, keeps copy items).
     */
    take(): ClipboardContent | null {
      if (!content) return null;
      const result = content;
      if (content.operation === "cut") {
        content = null;
        broadcast(null);
      }
      return result;
    },

    /** Update clipboard entries when a file is renamed. */
    updatePath(oldPath: string, newEntry: FileEntry): void {
      if (!content) return;
      const idx = content.entries.findIndex((e) => e.path === oldPath);
      if (idx === -1) return;
      const updated = [...content.entries];
      updated[idx] = newEntry;
      content = { ...content, entries: updated };
      broadcast(content);
    },

    async hasOsFiles(): Promise<boolean> {
      return osClipboardHasFiles();
    },

    async readOsFiles(): Promise<OsClipboardContent | null> {
      const paths = await osClipboardReadFiles();
      if (paths.length === 0) return null;
      return { paths, operation: "copy" };
    },

    /** Cleanup listener (call on app unmount). */
    destroy(): void {
      unlisten?.();
    },
  };
}

export const clipboardStore = createClipboardStore();
