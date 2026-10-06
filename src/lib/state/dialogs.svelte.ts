/**
 * Global dialog state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k, tauri-fl0e
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages all modal/overlay dialogs in the application.
 * Provides type-safe methods to open/close dialogs, replacing the
 * previous window.dispatchEvent custom event pattern.
 */

import { modalOwnership } from "./modal-ownership.svelte";
import { openWithStore } from "./open-with.svelte";
import type { FileEntry } from "$lib/domain/file";

export type DialogType = "rename" | "delete" | null;

export interface PickerOption {
  id: string;
  label: string;
  current?: boolean;
}

export interface PickerConfig {
  title: string;
  options: PickerOption[];
  onSelect: (id: string) => void;
}

function createDialogStore() {
  // File operation dialogs (mutually exclusive)
  let activeDialog = $state<DialogType>(null);
  let targetEntry = $state<FileEntry | null>(null);
  let targetEntries = $state<FileEntry[]>([]);
  let permanentDelete = $state(false);
  let fileOperationSession = $state.raw<object | null>(null);

  // Overlay dialogs (independent, can coexist with file ops but not each other)
  let quickOpenOpen = $state(false);
  let commandPaletteOpen = $state(false);
  let settingsOpen = $state(false);
  let aboutOpen = $state(false);
  let contentSearchOpen = $state(false);
  let workspaceOpen = $state(false);
  let bulkRenameOpen = $state(false);
  let bulkRenameItems = $state<FileEntry[]>([]);
  let jobsPanelOpen = $state(false);
  let themePickerOpen = $state(false);
  let shortcutsOpen = $state(false);
  let keybindingsOpen = $state(false);
  let pickerConfig = $state<PickerConfig | null>(null);
  let userReportOpen = $state(false);
  let fileRecoveryOpen = $state(false);
  let imageEditorTarget = $state.raw<{ path: string; name: string } | null>(null);

  function closeIfActive(dialogType: DialogType, session = fileOperationSession): void {
    if (activeDialog === dialogType && session === fileOperationSession) {
      activeDialog = null;
      fileOperationSession = null;
      targetEntry = null;
      targetEntries = [];
      permanentDelete = false;
    }
  }

  return {
    // File operation dialog accessors
    get activeDialog() {
      return activeDialog;
    },
    /** Identity of this opening, including reopening the same entry. */
    get fileOperationSession() {
      return fileOperationSession;
    },
    get targetEntry() {
      return targetEntry;
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
    get isPermanentDelete() {
      return permanentDelete;
    },

    // Overlay dialog accessors
    get isQuickOpenOpen() {
      return quickOpenOpen;
    },
    get isCommandPaletteOpen() {
      return commandPaletteOpen;
    },
    get isThemePickerOpen() {
      return themePickerOpen;
    },
    get isShortcutsOpen() {
      return shortcutsOpen;
    },
    get isAboutOpen() {
      return aboutOpen;
    },
    get isSettingsOpen() {
      return settingsOpen;
    },
    get isKeybindingsOpen() {
      return keybindingsOpen;
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
    get isJobsPanelOpen() {
      return jobsPanelOpen;
    },
    get isPickerOpen() {
      return pickerConfig !== null;
    },
    get pickerConfig() {
      return pickerConfig;
    },
    get isUserReportOpen() {
      return userReportOpen;
    },

    get isFileRecoveryOpen() { return fileRecoveryOpen; },
    get imageEditorTarget() { return imageEditorTarget; },

    openImageEditor(entry: FileEntry): void {
      commandPaletteOpen = false;
      imageEditorTarget = { path: entry.path, name: entry.name };
    },

    closeImageEditor(target = imageEditorTarget): void {
      if (target === imageEditorTarget) imageEditorTarget = null;
    },

    // File operation actions
    startRename(entry: FileEntry): void {
      fileOperationSession = {};
      activeDialog = "rename";
      targetEntry = entry;
    },

    cancelRename(session = fileOperationSession): void {
      closeIfActive("rename", session);
    },

    startDelete(entries: FileEntry[], isPermanent = false): void {
      fileOperationSession = {};
      activeDialog = "delete";
      targetEntries = entries;
      targetEntry = entries.length === 1 ? entries[0] : null;
      permanentDelete = isPermanent;
    },

    cancelDelete(session = fileOperationSession): void {
      closeIfActive("delete", session);
    },

    /** True when any modal dialog is open (file ops or overlays). */
    get hasModalOpen(): boolean {
      return openWithStore.isOpen || modalOwnership.hasOpen || imageEditorTarget !== null || shortcutsOpen || keybindingsOpen || activeDialog !== null || quickOpenOpen || commandPaletteOpen || settingsOpen || aboutOpen || contentSearchOpen || workspaceOpen || bulkRenameOpen || jobsPanelOpen || themePickerOpen || pickerConfig !== null || userReportOpen || fileRecoveryOpen;
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

    openAbout(): void {
      commandPaletteOpen = false;
      aboutOpen = true;
    },

    closeAbout(): void {
      aboutOpen = false;
    },

    openSettings(): void {
      keybindingsOpen = false;
      settingsOpen = true;
    },

    openKeybindings(): void {
      commandPaletteOpen = false;
      shortcutsOpen = false;
      settingsOpen = false;
      keybindingsOpen = true;
    },

    closeKeybindings(): void {
      keybindingsOpen = false;
    },

    openShortcuts(): void {
      shortcutsOpen = true;
    },

    closeShortcuts(): void {
      shortcutsOpen = false;
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

    openJobsPanel(): void {
      jobsPanelOpen = true;
    },

    closeJobsPanel(): void {
      jobsPanelOpen = false;
    },

    openThemePicker(): void {
      themePickerOpen = true;
    },

    closeThemePicker(): void {
      themePickerOpen = false;
    },

    openPicker(config: PickerConfig): void {
      pickerConfig = config;
    },

    closePicker(): void {
      pickerConfig = null;
    },

    openUserReport(): void {
      commandPaletteOpen = false;
      userReportOpen = true;
    },

    closeUserReport(): void {
      userReportOpen = false;
    },

    openFileRecovery(): void {
      commandPaletteOpen = false;
      fileRecoveryOpen = true;
    },

    closeFileRecovery(): void { fileRecoveryOpen = false; },

    closeAll(): void {
      modalOwnership.closeAll();
      // Rendered editors close through their modal's canClose contract. Clear
      // an opening that has not mounted yet, while retaining an accepted save.
      if (!modalOwnership.hasOpen) imageEditorTarget = null;
      openWithStore.close();
      shortcutsOpen = false;
      activeDialog = null;
      keybindingsOpen = false;
      fileOperationSession = null;
      permanentDelete = false;
      targetEntry = null;
      targetEntries = [];
      quickOpenOpen = false;
      commandPaletteOpen = false;
      settingsOpen = false;
      aboutOpen = false;
      contentSearchOpen = false;
      workspaceOpen = false;
      bulkRenameOpen = false;
      bulkRenameItems = [];
      jobsPanelOpen = false;
      themePickerOpen = false;
      pickerConfig = null;
      userReportOpen = false;
      fileRecoveryOpen = false;
    },
  };
}

export const dialogStore = createDialogStore();
