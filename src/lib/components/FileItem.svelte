<!--
  FileItem component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { formatSize } from "$lib/domain/file";
  import { getFileType, getFileIconColor, getFileIconCategory, formatDate, type IconCategory } from "$lib/domain/file-types";
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { moveEntry } from "$lib/api/files";

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
  const isRenaming = $derived(explorer.state.renamingEntry?.path === entry.path);

  // When rename mode starts, initialize and focus the input
  $effect(() => {
    if (isRenaming && renameInputRef) {
      editedName = entry.name;
      renameError = null;
      // Focus and select filename (without extension for files)
      setTimeout(() => {
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
      }, 0);
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
    clipboardStore.content?.entry.path === entry.path
  );
  const isCut = $derived(
    isInClipboard && clipboardStore.isCut
  );

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (isRenaming) return; // Don't handle item-level shortcuts when renaming

    const hasModifier = event.ctrlKey || event.metaKey;

    // Special keys (Delete, F2) - use exact match
    const keyActions: Record<string, () => void> = {
      Delete: () => explorer.startDelete(entry),
      F2: () => explorer.startRename(entry),
    };

    // Modifier keys - normalize to lowercase for consistent comparison (handles Caps Lock)
    const modifierKeyActions: Record<string, () => void> = {
      c: () => explorer.copyToClipboard(entry),
      x: () => explorer.cutToClipboard(entry),
    };

    const normalizedKey = event.key.toLowerCase();
    const action = keyActions[event.key] ?? (hasModifier ? modifierKeyActions[normalizedKey] : undefined);

    if (action) {
      event.preventDefault();
      action();
    }
  }

  // Drag handlers - allow dragging files/folders
  let isDropTarget = $state(false);

  function handleDragStart(event: DragEvent) {
    if (!event.dataTransfer) return;

    // Set drag data with file info
    event.dataTransfer.setData("application/x-explorer-path", entry.path);
    event.dataTransfer.setData("application/x-explorer-name", entry.name);
    event.dataTransfer.setData("application/x-explorer-kind", entry.kind);
    event.dataTransfer.effectAllowed = "move";
  }

  // Drop handlers - allow dropping files/folders into directories
  function handleDragOver(event: DragEvent) {
    // Only accept drops on directories
    if (entry.kind !== "directory") return;
    if (!event.dataTransfer?.types.includes("application/x-explorer-path")) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    isDropTarget = true;
  }

  function handleDragLeave() {
    isDropTarget = false;
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDropTarget = false;

    if (entry.kind !== "directory") return;
    if (!event.dataTransfer) return;

    const sourcePath = event.dataTransfer.getData("application/x-explorer-path");
    if (!sourcePath || sourcePath === entry.path) return;

    // Don't allow moving a folder into itself or its children
    if (entry.path.startsWith(sourcePath + "/")) return;

    const result = await moveEntry(sourcePath, entry.path);
    if (result.ok) {
      // Refresh all panes to reflect the move (handles cross-pane moves)
      if (paneNav) {
        paneNav.refreshAllPanes();
      } else {
        explorer.refresh();
      }
    } else {
      console.error("Failed to move:", result.error);
    }
  }
</script>

<button
  class="file-item"
  class:directory={entry.kind === "directory"}
  class:cut={isCut}
  class:in-clipboard={isInClipboard}
  class:selected
  class:drop-target={isDropTarget}
  onmousedown={handleMouseDown}
  onclick={handleClick}
  ondblclick={handleDoubleClick}
  oncontextmenu={handleContextMenu}
  onkeydown={handleKeydown}
  draggable="true"
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <!-- Name column -->
  <div class="name-cell">
    <div class="icon" aria-hidden="true">
      {#if entry.kind === "directory"}
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L7.5 4.91421L8.12132 4.29289C8.30886 4.10536 8.56321 4 8.82843 4H13C13.8284 4 14.5 4.67157 14.5 5.5V6H15.5V5.5C15.5 4.11929 14.3807 3 13 3H8.82843C8.29799 3 7.78929 3.21071 7.41421 3.58579L7.5 3.67157L7.58579 3.58579C7.21071 3.21071 6.70201 3 6.17157 3H3.5C2.11929 3 1 4.11929 1 5.5V12.5C1 13.8807 2.11929 15 3.5 15H8V14H3.5C2.67157 14 2 13.3284 2 12.5V5.5Z"
            fill="currentColor"
            class="folder-back"
          />
          <path
            d="M2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5H14.5C15.0523 6.5 15.5 6.94772 15.5 7.5V12.5C15.5 13.6046 14.6046 14.5 13.5 14.5H4.5C3.39543 14.5 2.5 13.6046 2.5 12.5V7.5Z"
            fill="currentColor"
            class="folder-front"
          />
        </svg>
      {:else}
        {@const iconColor = getFileIconColor(entry)}
        {@const iconCategory = getFileIconCategory(entry)}
        {#if iconCategory === "image"}
          <!-- Image file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="3" y="3" width="12" height="12" rx="1.5" fill={iconColor} fill-opacity="0.15"/>
            <rect x="3" y="3" width="12" height="12" rx="1.5" stroke={iconColor} stroke-width="1.25"/>
            <circle cx="6.5" cy="6.5" r="1.5" fill={iconColor}/>
            <path d="M3 12L6 9L8.5 11.5L11 8L15 12V13.5C15 14.3284 14.3284 15 13.5 15H4.5C3.67157 15 3 14.3284 3 13.5V12Z" fill={iconColor} fill-opacity="0.4"/>
          </svg>
        {:else if iconCategory === "archive"}
          <!-- Archive file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill={iconColor} fill-opacity="0.15"/>
            <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke={iconColor} stroke-width="1.25"/>
            <rect x="7" y="4" width="4" height="2" rx="0.5" fill={iconColor}/>
            <rect x="7" y="7" width="4" height="2" rx="0.5" fill={iconColor}/>
            <rect x="7" y="10" width="4" height="3" rx="0.5" fill={iconColor}/>
          </svg>
        {:else if iconCategory === "code"}
          <!-- Code file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill={iconColor} fill-opacity="0.15"/>
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke={iconColor} stroke-width="1.25"/>
            <path d="M10 2V5C10 5.55228 10.4477 6 11 6H14" stroke={iconColor} stroke-width="1.25"/>
            <path d="M7.5 9L6 10.5L7.5 12M10.5 9L12 10.5L10.5 12" stroke={iconColor} stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else if iconCategory === "media"}
          <!-- Media file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="3" y="4" width="12" height="10" rx="1.5" fill={iconColor} fill-opacity="0.15"/>
            <rect x="3" y="4" width="12" height="10" rx="1.5" stroke={iconColor} stroke-width="1.25"/>
            <path d="M7 7V11L11 9L7 7Z" fill={iconColor}/>
          </svg>
        {:else if iconCategory === "executable"}
          <!-- Executable file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="3" y="3" width="12" height="12" rx="2" fill={iconColor} fill-opacity="0.15"/>
            <rect x="3" y="3" width="12" height="12" rx="2" stroke={iconColor} stroke-width="1.25"/>
            <path d="M6 9H12M9 6V12" stroke={iconColor} stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        {:else}
          <!-- Default document icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" fill={iconColor} fill-opacity="0.15"/>
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke={iconColor} stroke-width="1.25"/>
            <path d="M10 2V6C10 6.55228 10.4477 7 11 7H15" stroke={iconColor} stroke-width="1.25"/>
            <path d="M6.5 10H11.5M6.5 12.5H10" stroke={iconColor} stroke-width="1" stroke-linecap="round"/>
          </svg>
        {/if}
      {/if}
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
  <div class="date-cell">
    {formatDate(entry.modified)}
  </div>

  <!-- Type column -->
  <div class="type-cell">
    {getFileType(entry)}
  </div>

  <!-- Size column -->
  <div class="size-cell">
    {#if entry.kind === "file"}
      {formatSize(entry.size)}
    {:else}
      <span class="empty-cell">—</span>
    {/if}
  </div>
</button>

<style>
  .file-item {
    display: grid;
    grid-template-columns: var(--col-name, 300px) var(--col-date, 180px) var(--col-type, 120px) var(--col-size, 90px);
    gap: 0;
    align-items: center;
    padding: 4px 16px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: inherit;
    color: var(--text-primary);
    transition: all var(--transition-fast);
    position: relative;
    min-height: 32px;
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

  /* Selected state */
  .file-item.selected {
    background: var(--subtle-fill-secondary);
    border-color: var(--accent);
  }

  .file-item.selected:hover {
    background: var(--subtle-fill-tertiary);
  }

  /* Cut items appear faded */
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
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  /* Folder colors - Windows 11 vibrant golden yellow */
  .folder-back {
    opacity: 0.65;
  }

  .folder-front {
    opacity: 1;
  }

  .directory .icon {
    color: #ffb900;
  }

  .file-item:not(.directory) .icon {
    color: var(--text-secondary);
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
    font-size: 13px;
    color: var(--text-secondary);
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

  /* Dark mode folder color adjustment */
  @media (prefers-color-scheme: dark) {
    .directory .icon {
      color: #ffc83d;
    }

    .file-item:not(.directory) .icon {
      color: var(--text-tertiary);
    }
  }
</style>
