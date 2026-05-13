<!--
  FileItem component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { formatSize } from "$lib/domain/file";
  import { getFileType, getFileIconColor, formatDate } from "$lib/domain/file-types";
  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { useItemInteractions, isInClipboard as checkInClipboard, isClipboardCut } from "$lib/composables/use-item-interactions.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { isMac } from "$lib/domain/platform";

  interface Props {
    entry: FileEntry;
    onclick: (event: MouseEvent) => void;
    ondblclick: () => void;
    selected?: boolean;
    explorer: ExplorerInstance;
  }

  let { entry, onclick, ondblclick, selected = false, explorer }: Props = $props();

  // Get pane context for cross-pane operations
  const paneNav = getPaneNavigationContext();

  // Shared item interactions (DnD, context menu)
  const interactions = useItemInteractions({
    getExplorer: () => explorer,
    getPaneNav: () => paneNav,
  });

  const pointerDrag = isMac ? usePointerDrag({ getExplorer: () => explorer, getPaneNav: () => paneNav }) : null;

  // Check if this entry is being renamed (used for click guards and badge visibility)
  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);

  // Clipboard state
  const entryInClipboard = $derived(checkInClipboard(entry));
  const isCut = $derived(isClipboardCut(entry));

  const isManuallyHidden = $derived(manualHiddenStore.isHidden(explorer.currentPath, entry.name));

  function handleClick(event: MouseEvent) {
    if (isRenaming) {
      event.stopPropagation();
      return;
    }
    onclick(event);
  }

  function handleDoubleClick() {
    ondblclick();
  }
</script>

<button
  class="file-item entry-item"
  data-path={entry.path}
  class:directory={entry.kind === "directory"}
  class:hidden-entry={entry.name.startsWith(".") || isManuallyHidden}
  class:cut={isCut}
  class:in-clipboard={entryInClipboard}
  class:selected
  class:drop-target={interactions.isDropTarget(entry.path)}
  class:copy-drop={interactions.isCopyDrop(entry.path)}
  onclick={handleClick}
  ondblclick={handleDoubleClick}
  oncontextmenu={(e) => interactions.handleContextMenu(e, entry)}
  draggable={!isMac}
  ondragstart={!isMac ? (e) => interactions.handleDragStart(e, entry, selected) : undefined}
  ondragend={!isMac ? interactions.handleDragEnd : undefined}
  ondragover={(e) => interactions.handleDragOver(e, entry)}
  ondragleave={() => interactions.handleDragLeave(entry)}
  ondrop={(e) => interactions.handleDrop(e, entry)}
  onmousedown={isMac ? (e) => { e.stopPropagation(); pointerDrag!.handlePointerDown(e, entry, selected); } : undefined}
>
  <!-- Name column -->
  <div class="name-cell">
    <div class="icon" style:--file-icon-color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined} aria-hidden="true">
      <FileIcon {entry} size="small" />
    </div>
    <EntryName {entry} {explorer} variant="details" />
    <GitStatusBadge entryName={entry.name} hideOnRename={isRenaming} />
    {#if entry.is_symlink && !isRenaming}
      <div class="symlink-badge" title={entry.symlink_target ? `Link to ${entry.symlink_target}` : "Symbolic link"}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M7 3L3 7M3 3L3 7L7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    {/if}
    {#if entryInClipboard && !isRenaming}
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
    transition: background var(--transition-fast), opacity var(--transition-fast);
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

  /* Name styles are handled by EntryName component */

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
