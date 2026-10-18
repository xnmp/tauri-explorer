/**
 * Global dialog state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k, tauri-fl0e
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages all modal/overlay dialogs in the application.
 * Provides type-safe methods to open/close dialogs, replacing the
 * previous window.dispatchEvent custom event pattern.
 */

import { modalOwnership, type ModalScope } from "./modal-ownership.svelte";
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
  let themePickerKind = $state<'color' | 'icon'>('color');
  let shortcutsOpen = $state(false);
  let keybindingsOpen = $state(false);
  let pluginsOpen = $state(false);
  let pickerConfig = $state<PickerConfig | null>(null);
  let userReportOpen = $state(false);
  let fileRecoveryOpen = $state(false);
  /** `tool` opens a plugin editor tool directly instead of crop. */
  let imageEditorTarget = $state.raw<{ path: string; name: string; tool?: string } | null>(null);
  // Plugin requests wait for their own editor opening to close.
  const imageEditorClosed = new Map<object, () => void>();

  function releaseImageEditor(target: object | null): void {
    if (!target) return;
    imageEditorClosed.get(target)?.();
    imageEditorClosed.delete(target);
  }

  function closeImageEditor(target: object | null = imageEditorTarget): void {
    if (target !== imageEditorTarget) return;
    imageEditorTarget = null;
    releaseImageEditor(target);
  }

  function anyModalOpen(): boolean {
    return openWithStore.isOpen || modalOwnership.hasOpen || imageEditorTarget !== null || shortcutsOpen || keybindingsOpen || pluginsOpen || activeDialog !== null || quickOpenOpen || commandPaletteOpen || settingsOpen || aboutOpen || contentSearchOpen || workspaceOpen || bulkRenameOpen || jobsPanelOpen || themePickerOpen || pickerConfig !== null || userReportOpen || fileRecoveryOpen;
  }

  function closeIfActive(dialogType: DialogType, session = fileOperationSession): void {
    if (activeDialog === dialogType && session === fileOperationSession) {
      activeDialog = null;
      fileOperationSession = null;
      targetEntry = null;
      targetEntries = [];
      permanentDelete = false;
    }
  }

  function closeUnmountedDialogs(): void {
    releaseImageEditor(imageEditorTarget);
    imageEditorTarget = null;
    openWithStore.close();
    shortcutsOpen = false;
    activeDialog = null;
    pluginsOpen = false;
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
    get themePickerKind() { return themePickerKind; },
    get isShortcutsOpen() {
      return shortcutsOpen;
    },
    get isAboutOpen() {
      return aboutOpen;
    },
    get isSettingsOpen() {
      return settingsOpen;
    },
    get isPluginsOpen() {
      return pluginsOpen;
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
      // A replaced plugin opening is closed, so its caller still settles.
      releaseImageEditor(imageEditorTarget);
      imageEditorTarget = { path: entry.path, name: entry.name };
    },

    /**
     * Opens the editor directly in a plugin's tool. `closed` settles when that
     * opening closes, however it closes; `close` closes only that opening.
     */
    openImageEditorTool(path: string, name: string, tool: string): { closed: Promise<void>; close: () => void } {
      if (imageEditorTarget) throw new Error("Close the open image editor first");
      commandPaletteOpen = false;
      // It would register above a modal drawn over it and take its focus/Escape.
      if (anyModalOpen()) throw new Error("Close the open dialog first");
      const target = { path, name, tool };
      const closed = new Promise<void>((resolve) => imageEditorClosed.set(target, resolve));
      imageEditorTarget = target;
      return { closed, close: () => closeImageEditor(target) };
    },

    closeImageEditor(target: object | null = imageEditorTarget): void {
      closeImageEditor(target);
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
      return anyModalOpen();
    },
    /** Pane input includes window modals, but never another pane's bucket. */
    isPaneBlocked(paneId: string): boolean {
      return anyModalOpen() || modalOwnership.hasPaneOpen(paneId);
    },
    inputScope(event: Event, activePaneId: string): ModalScope | undefined {
      return anyModalOpen() ? null : modalOwnership.inputScope(event, activePaneId);
    },
    isInputBlocked(event: Event, activePaneId: string): boolean {
      return this.inputScope(event, activePaneId) !== undefined;
    },
    subscribeOwnership: modalOwnership.subscribe,

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
      pluginsOpen = false;
      keybindingsOpen = false;
      settingsOpen = true;
    },

    openKeybindings(): void {
      pluginsOpen = false;
      commandPaletteOpen = false;
      shortcutsOpen = false;
      settingsOpen = false;
      keybindingsOpen = true;
    },

    openPlugins(): void {
      commandPaletteOpen = false;
      shortcutsOpen = false;
      settingsOpen = false;
      keybindingsOpen = false;
      pluginsOpen = true;
    },

    closePlugins(): void {
      pluginsOpen = false;
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

    openThemePicker(kind: 'color' | 'icon' = 'color'): void {
      themePickerKind = kind;
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

    requestCloseTop(event?: KeyboardEvent, scope: ModalScope = null): void {
      if (!modalOwnership.requestTopClose(event, scope) && !scope) closeUnmountedDialogs();
    },

    closeAll(): void {
      modalOwnership.closeAll();
      // Mounted close guards own the outcome. A veto or pending unmount must
      // retain every suspended built-in flag and its caller's draft.
      if (modalOwnership.hasOpen) return;
      closeUnmountedDialogs();
    },
  };
}

export const dialogStore = createDialogStore();
