<!--
  FileItem component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
-->
<script lang="ts">
  import { tick } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { formatSize } from "$lib/domain/file";
  import { getFileType, getFileIconColor, formatDate } from "$lib/domain/file-types";
  import FileIcon from "./FileIcon.svelte";
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { moveEntry, copyEntry, fetchDirectory } from "$lib/api/files";
  import { broadcastFileChange, parentDir } from "$lib/state/file-events";
  import { undoStore } from "$lib/state/undo.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { conflictResolver } from "$lib/state/conflict-resolver.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";

  interface Props {
    entry: FileEntry;
    onclick: (event: MouseEvent) => void;
    ondblclick: () => void;
    selected?: boolean;
    explorer?: ExplorerInstance;
  }

  let { entry, onclick, ondblclick, selected = false, explorer = defaultExplorer }: Props = $props();

  // Get pane context for cross-pane operations
  const paneNav = getPaneNavigationContext();

  // Slow-click-to-rename state (Windows Explorer behavior)
  let wasSelectedOnMouseDown = false;
  let renameClickTimeout: ReturnType<typeof setTimeout> | null = null;
  let nameClickPending = false;

  // Inline rename state
  let renameInputRef: HTMLInputElement | null = null;
  let editedName = $state("");
  let renameError = $state<string | null>(null);
  let submittingRename = $state(false);

  // Check if this entry is being renamed
  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);

  // When rename mode starts, initialize and focus the input
  $effect(() => {
    if (isRenaming && renameInputRef) {
      editedName = entry.name;
      renameError = null;
      // Focus and select filename (without extension for files)
      tick().then(() => {
        renameInputRef?.focus();
        if (entry.kind === "file") {
          const lastDot = entry.name.lastIndexOf(".");
          if (lastDot > 0) {
            renameInputRef?.setSelectionRange(0, lastDot);
          } else {
            renameInputRef?.select();
          }
        } else {
          renameInputRef?.select();
        }
      });
    }
  });

  async function confirmRename() {
    if (submittingRename) return;

    const trimmedName = editedName.trim();
    if (!trimmedName) {
      renameError = "Name cannot be empty";
      return;
    }

    if (trimmedName === entry.name) {
      explorer.cancelRename();
      return;
    }

    submittingRename = true;
    renameError = null;

    const result = await explorer.rename(trimmedName);

    submittingRename = false;

    if (result) {
      renameError = result;
    }
  }

  function cancelRename() {
    editedName = "";
    renameError = null;
    explorer.cancelRename();
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      confirmRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    }
  }

  function handleRenameBlur() {
    // Confirm on blur (like Windows Explorer)
    if (editedName.trim() && editedName.trim() !== entry.name) {
      confirmRename();
    } else {
      cancelRename();
    }
  }

  // Track if item was selected before mousedown (for slow-click-to-rename)
  function handleMouseDown() {
    wasSelectedOnMouseDown = selected;
  }

  function handleClick(event: MouseEvent) {
    if (isRenaming) {
      event.stopPropagation();
      return;
    }

    // Clear any pending rename timeout
    if (renameClickTimeout) {
      clearTimeout(renameClickTimeout);
      renameClickTimeout = null;
    }

    // Check if click was on the name area (for slow-click-to-rename)
    const target = event.target as HTMLElement;
    const isNameClick = target.classList.contains("name") || target.closest(".name-cell");

    // If item was already selected before this click, on the name area,
    // and it's a simple left click (no modifiers), schedule rename
    if (wasSelectedOnMouseDown && isNameClick && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      nameClickPending = true;
      renameClickTimeout = setTimeout(() => {
        if (nameClickPending) {
          explorer.startRename(entry);
        }
        nameClickPending = false;
        renameClickTimeout = null;
      }, 500); // 500ms delay to distinguish from double-click
    }

    onclick(event);
  }

  // Cancel slow-click-to-rename on double-click
  function handleDoubleClick() {
    if (renameClickTimeout) {
      clearTimeout(renameClickTimeout);
      renameClickTimeout = null;
    }
    nameClickPending = false;
    ondblclick();
  }

  // Check if this item is in clipboard (for visual feedback)
  const isInClipboard = $derived(
    clipboardStore.content?.entries.some((e) => e.path === entry.path) ?? false
  );
  const isCut = $derived(
    isInClipboard && clipboardStore.isCut
  );

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  // Drag handlers - allow dragging files/folders
  let isDropTarget = $state(false);
  let isCopyDrop = $state(false);

  function handleDragStart(event: DragEvent) {
    if (!event.dataTransfer) return;

    // Set drag data with file info (both dataTransfer and shared state)
    event.dataTransfer.setData("application/x-explorer-path", entry.path);
    event.dataTransfer.setData("application/x-explorer-name", entry.name);
    event.dataTransfer.setData("application/x-explorer-kind", entry.kind);
    event.dataTransfer.effectAllowed = "all";

    // Also set shared drag state (dataTransfer is unreliable in some webviews)
    dragState.start({ path: entry.path, name: entry.name, kind: entry.kind });
  }

  function handleDragEnd() {
    // After a drag ends, refresh panes to reflect any cross-window moves.
    // Internal drops already call refreshAllPanes(), so this is a no-op
    // in that case (just a redundant refresh). For external drops (another
    // window), this ensures the source window updates.
    dragState.clear();
    if (paneNav) {
      paneNav.refreshAllPanes();
    } else {
      explorer.refresh();
    }
  }

  // Drop handlers - allow dropping files/folders into directories
  function handleDragOver(event: DragEvent) {
    // Only accept drops on directories
    if (entry.kind !== "directory") return;
    // Accept if dataTransfer has our type, OR if there's cross-window drag data
    if (!event.dataTransfer?.types.includes("application/x-explorer-path") && !dragState.readCrossWindow()) return;

    event.preventDefault();
    // Ctrl held = copy, otherwise move
    const copying = event.ctrlKey;
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    isDropTarget = true;
    isCopyDrop = copying;
  }

  function handleDragLeave() {
    isDropTarget = false;
    isCopyDrop = false;
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDropTarget = false;
    isCopyDrop = false;

    if (entry.kind !== "directory") return;
    if (!event.dataTransfer) return;

    // Try dataTransfer first, fall back to cross-window drag state
    let sourcePath = event.dataTransfer.getData("application/x-explorer-path");
    if (!sourcePath) {
      const crossWindow = dragState.readCrossWindow();
      if (crossWindow) sourcePath = crossWindow.path;
    }
    if (!sourcePath || sourcePath === entry.path) return;

    // Don't allow moving/copying a folder into itself or its children
    if (entry.path.startsWith(sourcePath + "/")) return;

    // Ctrl held = copy, otherwise move
    const isCopyOp = event.ctrlKey;
    const fileName = sourcePath.split("/").pop() || sourcePath;

    // Check for naming conflict in target directory
    let overwrite = false;
    const dirResult = await fetchDirectory(entry.path);
    if (dirResult.ok) {
      const existingNames = new Set(dirResult.data.entries.map((e) => e.name));
      if (existingNames.has(fileName)) {
        const { choice } = await conflictResolver.prompt({
          fileName,
          sourcePath,
          remaining: 0,
        });
        if (choice === "skip" || choice === "cancel") return;
        if (choice === "overwrite") overwrite = true;
      }
    }

    const result = isCopyOp
      ? await copyEntry(sourcePath, entry.path, overwrite)
      : await moveEntry(sourcePath, entry.path, overwrite);

    if (result.ok) {
      if (isCopyOp) {
        toastStore.show(`Copied ${fileName} to ${entry.name}`, "info");
      } else {
        undoStore.push({
          type: "move",
          sourcePath,
          destPath: result.data.path,
          originalDir: parentDir(sourcePath),
        });
        toastStore.show(`Moved ${fileName} to ${entry.name}`, "info");
      }
      if (paneNav) {
        paneNav.refreshAllPanes();
      } else {
        explorer.refresh();
      }
      broadcastFileChange([parentDir(sourcePath), entry.path]);
    } else {
      console.error(`Failed to ${isCopyOp ? "copy" : "move"}:`, result.error);
      toastStore.error(result.error);
    }
  }
</script>

<button
  class="file-item"
  class:directory={entry.kind === "directory"}
  class:hidden-entry={entry.name.startsWith(".")}
  class:cut={isCut}
  class:in-clipboard={isInClipboard}
  class:selected
  class:drop-target={isDropTarget}
  class:copy-drop={isCopyDrop}
  onmousedown={handleMouseDown}
  onclick={handleClick}
  ondblclick={handleDoubleClick}
  oncontextmenu={handleContextMenu}
  draggable="true"
  ondragstart={handleDragStart}
  ondragend={handleDragEnd}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <!-- Name column -->
  <div class="name-cell">
    <div class="icon" style:--file-icon-color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined} aria-hidden="true">
      <FileIcon {entry} size="small" />
    </div>
    {#if isRenaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        class="rename-input"
        class:error={!!renameError}
        bind:value={editedName}
        bind:this={renameInputRef}
        onkeydown={handleRenameKeydown}
        onblur={handleRenameBlur}
        onclick={(e) => e.stopPropagation()}
        disabled={submittingRename}
        autofocus
      />
    {:else}
      <span class="name">{entry.name}</span>
    {/if}
    {#if entry.is_symlink && !isRenaming}
      <div class="symlink-badge" title={entry.symlink_target ? `Link to ${entry.symlink_target}` : "Symbolic link"}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M7 3L3 7M3 3L3 7L7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    {/if}
    {#if isInClipboard && !isRenaming}
      <div class="clipboard-badge" aria-label={isCut ? "Cut" : "Copied"}>
        {#if isCut}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 2L1.5 3.5L3 5M7 2L8.5 3.5L7 5M2 3.5H8" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2.5 2.5H7.5M2.5 2.5V7.5C2.5 7.77614 2.72386 8 3 8H7C7.27614 8 7.5 7.77614 7.5 7.5V2.5M2.5 2.5L3 1.5H7L7.5 2.5M4.5 4.5V6M5.5 4.5V6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Date modified column -->
  {#if settingsStore.columnVisibility.date}
  <div class="date-cell">
    {formatDate(entry.modified)}
  </div>
  {/if}

  <!-- Type column -->
  {#if settingsStore.columnVisibility.type}
  <div class="type-cell">
    {getFileType(entry)}
  </div>
  {/if}

  <!-- Size column -->
  {#if settingsStore.columnVisibility.size}
  <div class="size-cell">
    {#if entry.kind === "file"}
      {formatSize(entry.size)}
    {:else}
      <span class="empty-cell">—</span>
    {/if}
  </div>
  {/if}
</button>

<style>
  .file-item {
    display: grid;
    grid-template-columns: var(--details-grid-columns, var(--col-name, 300px) var(--col-date, 180px) var(--col-type, 120px) var(--col-size, 90px));
    gap: 0;
    align-items: center;
    padding: 4px 16px;
    background: transparent;
    border: 1px solid transparent;
    border-left-width: var(--selection-indicator-width);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: inherit;
    color: var(--text-primary);
    transition: background var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
    position: relative;
    min-height: 34px;
  }

  .file-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .file-item:active {
    background: var(--subtle-fill-tertiary);
  }

  .file-item:focus-visible {
    outline: none;
    border-color: var(--accent);
    background: var(--subtle-fill-secondary);
    box-shadow: 0 0 0 1px var(--accent);
  }

  /* Selected state - accent-tinted background */
  .file-item.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .file-item.selected:hover {
    background: var(--subtle-fill-tertiary);
  }

  /* Cut items appear faded */
  .file-item.hidden-entry {
    opacity: 0.55;
  }

  .file-item.hidden-entry:hover,
  .file-item.hidden-entry.selected {
    opacity: 0.8;
  }

  .file-item.cut {
    opacity: 0.5;
  }

  .file-item.in-clipboard:not(.cut) {
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.06), rgba(0, 120, 212, 0.02));
    border-color: rgba(0, 120, 212, 0.2);
  }

  /* Name cell */
  .name-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  /* Icon container */
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }

  /* File icon colors - theme can override via --icon-file-tint */
  .file-item:not(.directory) .icon {
    color: var(--icon-file-tint, var(--file-icon-color, var(--text-secondary)));
  }

  /* Name */
  .name {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  /* Inline rename input */
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    font-size: 13px;
    font-family: inherit;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--control-fill);
    border: 1px solid var(--accent);
    border-radius: 3px;
    outline: none;
    box-shadow: 0 0 0 1px var(--accent);
  }

  .rename-input:focus {
    background: var(--control-fill-secondary);
  }

  .rename-input:disabled {
    opacity: 0.6;
  }

  .rename-input.error {
    border-color: var(--system-critical);
    box-shadow: 0 0 0 1px var(--system-critical);
  }

  /* Date, Type, Size cells */
  .date-cell,
  .type-cell,
  .size-cell {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size-cell {
    text-align: right;
    padding-right: 8px;
  }

  .empty-cell {
    opacity: 0.3;
  }

  /* Symlink badge */
  .symlink-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--text-tertiary);
    flex-shrink: 0;
    opacity: 0.7;
  }

  /* Clipboard badge */
  .clipboard-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: var(--accent);
    color: var(--text-on-accent);
    border-radius: 3px;
    flex-shrink: 0;
  }

  .file-item.cut .clipboard-badge {
    background: var(--system-caution);
  }

  /* Drop target state - for drag-to-move */
  .file-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  /* Copy drop visual - green tint when Ctrl held */
  .file-item.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    border-color: #10b981;
    box-shadow: inset 0 0 0 1px #10b981;
  }

</style>
