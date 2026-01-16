/**
 * Global dialog state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages modal dialogs for file operations (new folder, rename, delete).
 * Only one dialog can be open at a time.
 */

import type { FileEntry } from "$lib/domain/file";

export type DialogType = "newFolder" | "rename" | "delete" | null;

function createDialogStore() {
  let activeDialog = $state<DialogType>(null);
  let targetEntry = $state<FileEntry | null>(null);

  function closeIfActive(dialogType: DialogType): void {
    if (activeDialog === dialogType) {
      activeDialog = null;
      targetEntry = null;
    }
  }

  return {
    // Accessors
    get activeDialog() {
      return activeDialog;
    },
    get targetEntry() {
      return targetEntry;
    },
    get isNewFolderOpen() {
      return activeDialog === "newFolder";
    },
    get isRenameOpen() {
      return activeDialog === "rename";
    },
    get isDeleteOpen() {
      return activeDialog === "delete";
    },
    get renamingEntry() {
      return activeDialog === "rename" ? targetEntry : null;
    },
    get deletingEntry() {
      return activeDialog === "delete" ? targetEntry : null;
    },

    // Actions
    openNewFolder(): void {
      activeDialog = "newFolder";
      targetEntry = null;
    },

    closeNewFolder(): void {
      closeIfActive("newFolder");
    },

    startRename(entry: FileEntry): void {
      activeDialog = "rename";
      targetEntry = entry;
    },

    cancelRename(): void {
      closeIfActive("rename");
    },

    startDelete(entry: FileEntry): void {
      activeDialog = "delete";
      targetEntry = entry;
    },

    cancelDelete(): void {
      closeIfActive("delete");
    },

    closeAll(): void {
      activeDialog = null;
      targetEntry = null;
    },
  };
}

export const dialogStore = createDialogStore();
