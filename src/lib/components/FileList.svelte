<!--
  FileList component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-x25, tauri-explorer-as45, tauri-explorer-1k9k
-->
<script lang="ts">
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { openFile, moveEntry } from "$lib/api/files";
  import FileItem from "./FileItem.svelte";
  import VirtualList from "./VirtualList.svelte";
  import { useColumnResize } from "$lib/composables/use-column-resize.svelte";
  import { useMarqueeSelection } from "$lib/composables/use-marquee-selection.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer?: ExplorerInstance;
  }

  let { explorer = defaultExplorer }: Props = $props();

  // Get pane context for cross-pane operations
  const paneNav = getPaneNavigationContext();

  let pasteError = $state<string | null>(null);
  let pasteSuccess = $state(false);

  // Drop target state for dropping files into current directory
  let isDropTarget = $state(false);

  // Content container ref
  let contentRef = $state<HTMLElement | null>(null);

  // Column resize composable
  const columnResize = useColumnResize();

  // Marquee selection composable
  const marquee = useMarqueeSelection();

  function handleClick(entry: FileEntry, event: MouseEvent): void {
    explorer.selectEntry(entry, {
      ctrlKey: event.ctrlKey || event.metaKey,
      shiftKey: event.shiftKey,
    });
  }

  async function handleDoubleClick(entry: FileEntry): Promise<void> {
    if (entry.kind === "directory") {
      explorer.navigateTo(entry.path);
    } else {
      const result = await openFile(entry.path);
      if (!result.ok) {
        console.error("Failed to open file:", result.error);
      }
    }
  }

  function handleBackgroundClick(event: MouseEvent): void {
    // Only clear selection on click if not ending a drag
    if (marquee.isBackgroundClick(event.target as HTMLElement) && !marquee.isDragging && !marquee.dragJustEnded) {
      explorer.clearSelection();
    }
  }

  function handleMarqueeStart(event: MouseEvent): void {
    const rect = contentRef?.getBoundingClientRect();
    if (!rect) return;
    marquee.start(event, rect);
  }

  function handleMarqueeMove(event: MouseEvent): void {
    const rect = contentRef?.getBoundingClientRect();
    if (!rect) return;
    marquee.move(event, rect);
    updateMarqueeSelection();
  }

  function handleMarqueeEnd(): void {
    if (marquee.isDragging) {
      updateMarqueeSelection();
    }
    marquee.end();
  }

  function updateMarqueeSelection(): void {
    if (!marquee.marqueeRect || !contentRef) return;
    const scrollTop = contentRef.querySelector('.virtual-viewport')?.scrollTop ?? 0;
    const indices = marquee.getSelectedIndices(scrollTop, explorer.displayEntries.length);
    explorer.selectByIndices(indices, marquee.ctrlKeyHeld);
  }

  function handleBackgroundContextMenu(event: MouseEvent): void {
    if (marquee.isBackgroundClick(event.target as HTMLElement)) {
      event.preventDefault();
      explorer.clearSelection();
      explorer.openContextMenu(event.clientX, event.clientY);
    }
  }

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    const isPasteShortcut = event.key === "v" && (event.ctrlKey || event.metaKey);

    if (isPasteShortcut && clipboardStore.hasContent) {
      event.preventDefault();
      const error = await explorer.paste();

      if (error) {
        pasteError = error;
        setTimeout(() => (pasteError = null), 3000);
      } else {
        pasteSuccess = true;
        setTimeout(() => (pasteSuccess = false), 1500);
      }
    }
  }

  // Drop handlers for dropping files into current directory
  function handleListDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes("application/x-explorer-path")) return;

    // Check if target is a file item (let FileItem handle its own drops)
    const target = event.target as HTMLElement;
    if (target.closest(".file-item")) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    isDropTarget = true;
  }

  function handleListDragLeave(event: DragEvent): void {
    // Only clear if leaving the file list entirely
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    if (relatedTarget && contentRef?.contains(relatedTarget)) return;
    isDropTarget = false;
  }

  async function handleListDrop(event: DragEvent): Promise<void> {
    isDropTarget = false;

    // Check if target is a file item (let FileItem handle its own drops)
    const target = event.target as HTMLElement;
    if (target.closest(".file-item")) return;

    if (!event.dataTransfer) return;

    const sourcePath = event.dataTransfer.getData("application/x-explorer-path");
    if (!sourcePath) return;

    // Don't allow dropping into the same directory it's already in
    const currentPath = explorer.state.currentPath;
    const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
    if (sourceDir === currentPath) return;

    event.preventDefault();

    const result = await moveEntry(sourcePath, currentPath);
    if (result.ok) {
      // Refresh all panes to reflect the move
      if (paneNav) {
        paneNav.refreshAllPanes();
      } else {
        explorer.refresh();
      }
    } else {
      console.error("Failed to move:", result.error);
      pasteError = result.error;
      setTimeout(() => (pasteError = null), 3000);
    }
  }
</script>

<!-- Global mouse events for marquee and column resize -->
<svelte:window
  onmousemove={(e) => { handleMarqueeMove(e); columnResize.handleResize(e); }}
  onmouseup={() => { handleMarqueeEnd(); columnResize.endResize(); }}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="file-list" onkeydown={handleKeydown} onclick={handleBackgroundClick} oncontextmenu={handleBackgroundContextMenu} tabindex="-1">
  <!-- Clipboard indicator (uses global clipboardStore for cross-pane support) -->
  {#if clipboardStore.content}
    <div class="clipboard-banner" class:cut={clipboardStore.isCut}>
      <div class="clipboard-content">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {#if clipboardStore.isCut}
            <path d="M6 3L3 6L6 9M10 3L13 6L10 9M4 6H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          {:else}
            <path d="M4 4H12M4 4V12C4 12.5523 4.44772 13 5 13H11C11.5523 13 12 12.5523 12 12V4M4 4L5 2H11L12 4M7 7V10M9 7V10" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          {/if}
        </svg>
        <span class="clipboard-text">
          <strong>{clipboardStore.isCut ? "Cut" : "Copied"}:</strong>
          {clipboardStore.content.entry.name}
        </span>
        <span class="clipboard-hint">Ctrl+V to paste</span>
      </div>
      <button class="clipboard-clear" onclick={() => clipboardStore.clear()} aria-label="Clear clipboard">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  {/if}

  <!-- Toast notifications -->
  {#if pasteError}
    <div class="toast error" role="alert">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M8 5V8.5M8 11V10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>{pasteError}</span>
    </div>
  {/if}

  {#if pasteSuccess}
    <div class="toast success" role="status">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M5.5 8L7 9.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Pasted successfully</span>
    </div>
  {/if}

  <!-- Main content with column headers -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="content"
    class:drop-target={isDropTarget}
    bind:this={contentRef}
    onmousedown={handleMarqueeStart}
    ondragover={handleListDragOver}
    ondragleave={handleListDragLeave}
    ondrop={handleListDrop}
  >
    {#if explorer.state.loading}
      <div class="status">
        <div class="spinner"></div>
        <span>Loading...</span>
      </div>
    {:else if explorer.state.error}
      <div class="status error-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <path d="M24 16V26M24 32V30" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="error-title">Unable to access folder</span>
        <span class="error-message">{explorer.state.error}</span>
      </div>
    {:else if explorer.displayEntries.length === 0}
      <div class="status empty-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path d="M8 16C8 13.7909 9.79086 12 12 12H19.1716C19.702 12 20.2107 12.2107 20.5858 12.5858L23 15H36C38.2091 15 40 16.7909 40 19V34C40 36.2091 38.2091 38 36 38H12C9.79086 38 8 36.2091 8 34V16Z" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <path d="M20 27H28" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
        </svg>
        <span>This folder is empty</span>
      </div>
    {:else if explorer.state.viewMode === "details"}
      <!-- Details View with Column Headers -->
      <div class="details-view" class:resizing={columnResize.isResizing} style="--col-name: {columnResize.columnWidths.name}px; --col-date: {columnResize.columnWidths.date}px; --col-type: {columnResize.columnWidths.type}px; --col-size: {columnResize.columnWidths.size}px;">
        <div class="column-headers" style="grid-template-columns: {columnResize.gridTemplateColumns};">
          <div class="column-header-wrapper">
            <button
              class="column-header name-column"
              onclick={() => explorer.setSorting("name")}
              class:active={explorer.state.sortBy === "name"}
            >
              <span>Name</span>
              {#if explorer.state.sortBy === "name"}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                  {#if explorer.state.sortAscending}
                    <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                  {:else}
                    <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                  {/if}
                </svg>
              {/if}
            </button>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("name", e)}></div>
          </div>
          <div class="column-header-wrapper">
            <button
              class="column-header date-column"
              onclick={() => explorer.setSorting("modified")}
              class:active={explorer.state.sortBy === "modified"}
            >
              <span>Date modified</span>
              {#if explorer.state.sortBy === "modified"}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                  {#if explorer.state.sortAscending}
                    <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                  {:else}
                    <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                  {/if}
                </svg>
              {/if}
            </button>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("date", e)}></div>
          </div>
          <div class="column-header-wrapper">
            <div class="column-header type-column">
              <span>Type</span>
            </div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("type", e)}></div>
          </div>
          <div class="column-header-wrapper">
            <button
              class="column-header size-column"
              onclick={() => explorer.setSorting("size")}
              class:active={explorer.state.sortBy === "size"}
            >
              <span>Size</span>
              {#if explorer.state.sortBy === "size"}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                  {#if explorer.state.sortAscending}
                    <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                  {:else}
                    <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                  {/if}
                </svg>
              {/if}
            </button>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("size", e)}></div>
          </div>
        </div>

        <VirtualList
          items={explorer.displayEntries}
          itemHeight={32}
          getKey={(entry) => entry.path}
        >
          {#snippet children(entry, index)}
            <FileItem
              {entry}
              {explorer}
              onclick={(event) => handleClick(entry, event)}
              ondblclick={() => handleDoubleClick(entry)}
              selected={explorer.isSelected(entry)}
            />
          {/snippet}
        </VirtualList>
      </div>
    {:else if explorer.state.viewMode === "list"}
      <!-- Compact List View -->
      <div class="list-view file-rows">
        {#each explorer.displayEntries as entry (entry.path)}
          <button
            class="list-item"
            class:directory={entry.kind === "directory"}
            class:selected={explorer.isSelected(entry)}
            onclick={(e) => handleClick(entry, e)}
            ondblclick={() => handleDoubleClick(entry)}
          >
            <span class="list-icon">
              {#if entry.kind === "directory"}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="#ffb900"/>
                </svg>
              {:else}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M4 2C4 1.44772 4.44772 1 5 1H9L13 5V14C13 14.5523 12.5523 15 12 15H5C4.44772 15 4 14.5523 4 14V2Z" stroke="var(--text-tertiary)" stroke-width="1.25"/>
                  <path d="M9 1V4C9 4.55228 9.44772 5 10 5H13" stroke="var(--text-tertiary)" stroke-width="1.25"/>
                </svg>
              {/if}
            </span>
            <span class="list-name">{entry.name}</span>
          </button>
        {/each}
      </div>
    {:else}
      <!-- Tiles View (Grid) -->
      <div class="tiles-view file-rows">
        {#each explorer.displayEntries as entry (entry.path)}
          <button
            class="tile-item"
            class:directory={entry.kind === "directory"}
            class:selected={explorer.isSelected(entry)}
            onclick={(e) => handleClick(entry, e)}
            ondblclick={() => handleDoubleClick(entry)}
          >
            <div class="tile-icon">
              {#if entry.kind === "directory"}
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <path d="M6 15C6 13.3431 7.34315 12 9 12H17.7574C18.553 12 19.3161 12.3161 19.8787 12.8787L21 14H39C40.6569 14 42 15.3431 42 17V36C42 37.6569 40.6569 39 39 39H9C7.34315 39 6 37.6569 6 36V15Z" fill="#ffb900"/>
                </svg>
              {:else}
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <path d="M12 6C12 4.34315 13.3431 3 15 3H27L39 15V42C39 43.6569 37.6569 45 36 45H15C13.3431 45 12 43.6569 12 42V6Z" fill="var(--background-card)" stroke="var(--text-tertiary)" stroke-width="1.5"/>
                  <path d="M27 3V12C27 13.6569 28.3431 15 30 15H39" stroke="var(--text-tertiary)" stroke-width="1.5"/>
                </svg>
              {/if}
            </div>
            <span class="tile-name">{entry.name}</span>
          </button>
        {/each}
      </div>
    {/if}

    <!-- Marquee selection rectangle -->
    {#if marquee.isDragging && marquee.marqueeRect}
      <div
        class="marquee-rect"
        style="left: {marquee.marqueeRect.left}px; top: {marquee.marqueeRect.top}px; width: {marquee.marqueeRect.width}px; height: {marquee.marqueeRect.height}px;"
      ></div>
    {/if}
  </div>
</div>

<style>
  .file-list {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    position: relative;
  }

  .file-list:focus {
    outline: none;
  }

  .content {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow-y: auto;
    position: relative;
    transition: background var(--transition-fast), box-shadow var(--transition-fast);
  }

  .content.drop-target {
    background: rgba(0, 120, 212, 0.08);
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  /* Marquee selection rectangle */
  .marquee-rect {
    position: absolute;
    background: rgba(0, 120, 212, 0.15);
    border: 1px solid var(--accent);
    border-radius: 2px;
    pointer-events: none;
    z-index: 10;
  }

  /* Details View */
  .details-view {
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .column-headers {
    display: grid;
    gap: 0;
    padding: 6px 16px;
    background: var(--background-card-secondary);
    border-bottom: 1px solid var(--divider);
    position: sticky;
    top: 0;
    z-index: 5;
  }

  .column-header-wrapper {
    display: flex;
    align-items: center;
    position: relative;
  }

  .column-resize-handle {
    position: absolute;
    right: -4px;
    top: 0;
    width: 8px;
    height: 100%;
    cursor: col-resize;
    z-index: 10;
  }

  .column-resize-handle:hover,
  .details-view.resizing .column-resize-handle {
    background: var(--accent);
    opacity: 0.3;
  }

  .details-view.resizing {
    cursor: col-resize;
    user-select: none;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-radius: 3px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: left;
    flex: 1;
    min-width: 0;
  }

  .column-header:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .column-header.active {
    color: var(--text-primary);
  }

  .column-header:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .sort-indicator {
    opacity: 0.7;
  }

  /* Clipboard banner */
  .clipboard-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-sm) var(--spacing-md);
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.08), rgba(0, 120, 212, 0.04));
    border-bottom: 1px solid rgba(0, 120, 212, 0.15);
    color: var(--accent);
    animation: slideDown 200ms cubic-bezier(0, 0, 0, 1);
  }

  .clipboard-banner.cut {
    background: linear-gradient(135deg, rgba(157, 93, 0, 0.08), rgba(157, 93, 0, 0.04));
    border-color: rgba(157, 93, 0, 0.15);
    color: var(--system-caution);
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .clipboard-content {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: var(--font-size-caption);
  }

  .clipboard-text {
    color: var(--text-primary);
  }

  .clipboard-hint {
    color: var(--text-tertiary);
    padding-left: var(--spacing-sm);
    border-left: 1px solid var(--divider);
    margin-left: var(--spacing-xs);
  }

  .clipboard-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .clipboard-clear:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  /* Toast notifications */
  .toast {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    margin: var(--spacing-sm) var(--spacing-sm) 0;
    background: var(--background-acrylic);
    backdrop-filter: blur(20px);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-md);
    font-size: var(--font-size-caption);
    box-shadow: var(--shadow-tooltip);
    animation: toastIn 200ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes toastIn {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .toast.error {
    background: linear-gradient(135deg, rgba(196, 43, 28, 0.1), rgba(196, 43, 28, 0.05));
    border-color: rgba(196, 43, 28, 0.2);
    color: var(--system-critical);
  }

  .toast.success {
    background: linear-gradient(135deg, rgba(15, 123, 15, 0.1), rgba(15, 123, 15, 0.05));
    border-color: rgba(15, 123, 15, 0.2);
    color: var(--system-success);
  }

  /* Status states */
  .status {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-md);
    padding: var(--spacing-xl) * 2;
    text-align: center;
    color: var(--text-secondary);
    font-size: var(--font-size-body);
    flex: 1;
  }

  .empty-state,
  .error-state {
    animation: fadeIn 300ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  .error-state {
    color: var(--system-critical);
  }

  .error-title {
    font-weight: 500;
    color: var(--text-primary);
  }

  .error-message {
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
    max-width: 300px;
  }

  /* Loading spinner */
  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 800ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* List View */
  .list-view {
    display: flex;
    flex-direction: column;
    padding: 8px;
    gap: 2px;
    overflow-y: auto;
    flex: 1;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    transition: all var(--transition-fast);
  }

  .list-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .list-item.selected {
    background: var(--subtle-fill-secondary);
    border-color: var(--accent);
  }

  .list-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .list-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Tiles View */
  .tiles-view {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 8px;
    padding: 16px;
    overflow-y: auto;
    flex: 1;
  }

  .tile-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    text-align: center;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    transition: all var(--transition-fast);
  }

  .tile-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .tile-item.selected {
    background: var(--subtle-fill-secondary);
    border-color: var(--accent);
  }

  .tile-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
  }

  .tile-name {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.3;
  }
</style>
