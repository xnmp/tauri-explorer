/**
 * Global dialog state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k, tauri-fl0e
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages all modal/overlay dialogs in the application.
 * Provides type-safe methods to open/close dialogs, replacing the
 * previous window.dispatchEvent custom event pattern.
 */

import type { FileEntry } from "$lib/domain/file";

export type DialogType = "newFolder" | "rename" | "delete" | null;

function createDialogStore() {
  // File operation dialogs (mutually exclusive)
  let activeDialog = $state<DialogType>(null);
  let targetEntry = $state<FileEntry | null>(null);
  let targetEntries = $state<FileEntry[]>([]);

  // Overlay dialogs (independent, can coexist with file ops but not each other)
  let quickOpenOpen = $state(false);
  let commandPaletteOpen = $state(false);
  let settingsOpen = $state(false);
  let contentSearchOpen = $state(false);
  let workspaceOpen = $state(false);
  let bulkRenameOpen = $state(false);
  let bulkRenameItems = $state<FileEntry[]>([]);

  function closeIfActive(dialogType: DialogType): void {
    if (activeDialog === dialogType) {
      activeDialog = null;
      targetEntry = null;
      targetEntries = [];
    }
  }

  return {
    // File operation dialog accessors
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
    get deletingEntries() {
      return activeDialog === "delete" ? targetEntries : [];
    },

    // Overlay dialog accessors
    get isQuickOpenOpen() {
      return quickOpenOpen;
    },
    get isCommandPaletteOpen() {
      return commandPaletteOpen;
    },
    get isSettingsOpen() {
      return settingsOpen;
    },
    get isContentSearchOpen() {
      return contentSearchOpen;
    },
    get isWorkspaceOpen() {
      return workspaceOpen;
    },
    get isBulkRenameOpen() {
      return bulkRenameOpen;
    },
    get bulkRenameEntries() {
      return bulkRenameItems;
    },

    // File operation actions
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

    startDelete(entries: FileEntry[]): void {
      activeDialog = "delete";
      targetEntries = entries;
      targetEntry = entries.length === 1 ? entries[0] : null;
    },

    cancelDelete(): void {
      closeIfActive("delete");
    },

    /** True when any modal dialog is open (file ops or overlays). */
    get hasModalOpen(): boolean {
      return activeDialog !== null || quickOpenOpen || commandPaletteOpen || settingsOpen || contentSearchOpen || workspaceOpen || bulkRenameOpen;
    },

    // Overlay dialog actions
    openQuickOpen(): void {
      quickOpenOpen = true;
    },

    closeQuickOpen(): void {
      quickOpenOpen = false;
    },

    openCommandPalette(): void {
      commandPaletteOpen = true;
    },

    closeCommandPalette(): void {
      commandPaletteOpen = false;
    },

    openSettings(): void {
      settingsOpen = true;
    },

    closeSettings(): void {
      settingsOpen = false;
    },

    openContentSearch(): void {
      contentSearchOpen = true;
    },

    closeContentSearch(): void {
      contentSearchOpen = false;
    },

    openWorkspace(): void {
      workspaceOpen = true;
    },

    closeWorkspace(): void {
      workspaceOpen = false;
    },

    openBulkRename(entries: FileEntry[]): void {
      bulkRenameItems = entries;
      bulkRenameOpen = true;
    },

    closeBulkRename(): void {
      bulkRenameOpen = false;
      bulkRenameItems = [];
    },

    closeAll(): void {
      activeDialog = null;
      targetEntry = null;
      targetEntries = [];
      quickOpenOpen = false;
      commandPaletteOpen = false;
      settingsOpen = false;
      contentSearchOpen = false;
      workspaceOpen = false;
      bulkRenameOpen = false;
      bulkRenameItems = [];
    },
  };
}

export const dialogStore = createDialogStore();
