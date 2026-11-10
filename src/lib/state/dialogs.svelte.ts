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
import {
  NO_OVERLAYS,
  OVERLAY_IDS,
  closeAllOverlays,
  closeOverlay,
  isOverlayOpen,
  openOverlay,
  type OpenOverlays,
  type OverlayId,
} from "$lib/domain/overlays";

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

  // Boolean overlays (independent, can coexist with file ops but not each other);
  // the registry lives in domain/overlays.ts.
  // `overlays` is the source of truth; `openFlags` mirrors it one signal per id,
  // so a reader of one dialog is not invalidated when a different one changes.
  let overlays: OpenOverlays = NO_OVERLAYS;
  const openFlags = $state(Object.fromEntries(OVERLAY_IDS.map((id) => [id, false])) as Record<OverlayId, boolean>);
  const commit = (next: OpenOverlays): void => {
    overlays = next;
    for (const id of OVERLAY_IDS) {
      const value = isOverlayOpen(next, id);
      if (openFlags[id] !== value) openFlags[id] = value;
    }
  };
  let themePickerKind = $state<'color' | 'icon' | 'layout'>('color');
  let pickerConfig = $state<PickerConfig | null>(null);
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

  const isOpen = (id: OverlayId): boolean => openFlags[id];
  const open = (id: OverlayId, closing: readonly OverlayId[] = []): void => {
    commit(openOverlay(overlays, id, closing));
  };
  const close = (id: OverlayId): void => {
    commit(closeOverlay(overlays, id));
  };

  function anyModalOpen(): boolean {
    return openWithStore.isOpen || modalOwnership.hasOpen || imageEditorTarget !== null || activeDialog !== null || pickerConfig !== null || OVERLAY_IDS.some(isOpen);
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
    activeDialog = null;
    fileOperationSession = null;
    permanentDelete = false;
    targetEntry = null;
    targetEntries = [];
    pickerConfig = null;
    commit(closeAllOverlays());
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
      return isOpen("quickOpen");
    },
    get isCommandPaletteOpen() {
      return isOpen("commandPalette");
    },
    get isThemePickerOpen() {
      return isOpen("themePicker");
    },
    get themePickerKind() { return themePickerKind; },
    get isShortcutsOpen() {
      return isOpen("shortcuts");
    },
    get isAboutOpen() {
      return isOpen("about");
    },
    get isSettingsOpen() {
      return isOpen("settings");
    },
    get isPluginsOpen() {
      return isOpen("plugins");
    },
    get isKeybindingsOpen() {
      return isOpen("keybindings");
    },
    get isContentSearchOpen() {
      return isOpen("contentSearch");
    },
    get isWorkspaceOpen() {
      return isOpen("workspace");
    },
    get isJobsPanelOpen() {
      return isOpen("jobsPanel");
    },
    get isPickerOpen() {
      return pickerConfig !== null;
    },
    get pickerConfig() {
      return pickerConfig;
    },
    get isUserReportOpen() {
      return isOpen("userReport");
    },

    get isFileRecoveryOpen() { return isOpen("fileRecovery"); },
    get imageEditorTarget() { return imageEditorTarget; },

    openImageEditor(entry: FileEntry): void {
      close("commandPalette");
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
      close("commandPalette");
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
      open("quickOpen");
    },

    closeQuickOpen(): void {
      close("quickOpen");
    },

    openCommandPalette(): void {
      open("commandPalette");
    },

    closeCommandPalette(): void {
      close("commandPalette");
    },

    openAbout(): void {
      open("about", ["commandPalette"]);
    },

    closeAbout(): void {
      close("about");
    },

    openSettings(): void {
      open("settings", ["plugins", "keybindings"]);
    },

    openKeybindings(): void {
      open("keybindings", ["plugins", "commandPalette", "shortcuts", "settings"]);
    },

    openPlugins(): void {
      open("plugins", ["commandPalette", "shortcuts", "settings", "keybindings"]);
    },

    closePlugins(): void {
      close("plugins");
    },

    closeKeybindings(): void {
      close("keybindings");
    },

    openShortcuts(): void {
      open("shortcuts");
    },

    closeShortcuts(): void {
      close("shortcuts");
    },

    closeSettings(): void {
      close("settings");
    },

    openContentSearch(): void {
      open("contentSearch");
    },

    closeContentSearch(): void {
      close("contentSearch");
    },

    openWorkspace(): void {
      open("workspace");
    },

    closeWorkspace(): void {
      close("workspace");
    },

    openJobsPanel(): void {
      open("jobsPanel");
    },

    closeJobsPanel(): void {
      close("jobsPanel");
    },

    openThemePicker(kind: 'color' | 'icon' | 'layout' = 'color'): void {
      themePickerKind = kind;
      open("themePicker");
    },

    closeThemePicker(): void {
      close("themePicker");
    },

    openPicker(config: PickerConfig): void {
      pickerConfig = config;
    },

    closePicker(): void {
      pickerConfig = null;
    },

    openUserReport(): void {
      open("userReport", ["commandPalette"]);
    },

    closeUserReport(): void {
      close("userReport");
    },

    openFileRecovery(): void {
      open("fileRecovery", ["commandPalette"]);
    },

    closeFileRecovery(): void { close("fileRecovery"); },

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
