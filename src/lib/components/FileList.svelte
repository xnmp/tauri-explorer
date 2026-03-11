<!--
  FileList component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-x25, tauri-explorer-as45, tauri-explorer-1k9k, tauri-explorer-im3m
-->
<script lang="ts">
  import { tick } from "svelte";
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import { recentFilesStore } from "$lib/state/recent-files.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { openFile, openImageWithSiblings, moveEntry, copyEntry, fetchDirectory } from "$lib/api/files";
  import { broadcastFileChange, parentDir } from "$lib/state/file-events";
  import { undoStore } from "$lib/state/undo.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { conflictResolver } from "$lib/state/conflict-resolver.svelte";
  import FileItem from "./FileItem.svelte";
  import FileIcon from "./FileIcon.svelte";
  import VirtualList from "./VirtualList.svelte";
  import ThumbnailImage from "./ThumbnailImage.svelte";
  import { useColumnResize } from "$lib/composables/use-column-resize.svelte";
  import { useMarqueeSelection } from "$lib/composables/use-marquee-selection.svelte";
  import { useTypeAhead } from "$lib/composables/use-type-ahead.svelte";
  import { getFileIconColor, isImageFile } from "$lib/domain/file-types";
  import { settingsStore } from "$lib/state/settings.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer?: ExplorerInstance;
  }

  let { explorer = defaultExplorer }: Props = $props();

  // Get pane context for cross-pane operations
  const paneNav = getPaneNavigationContext();

  // Drop target state for dropping files into current directory
  let isDropTarget = $state(false);

  // Content container ref
  let contentRef = $state<HTMLElement | null>(null);

  // Compute effective list column count (auto or fixed)
  let contentWidth = $state(0);
  const effectiveListColumns = $derived.by(() => {
    if (settingsStore.listViewColumns > 0) return settingsStore.listViewColumns;
    if (contentWidth <= 0) return 1;
    return Math.max(1, Math.min(6, Math.floor(contentWidth / settingsStore.listColumnMaxWidth)));
  });

  // Track content width for auto columns
  $effect(() => {
    if (!contentRef) return;
    const observer = new ResizeObserver((entries) => {
      contentWidth = entries[0]?.contentRect.width ?? 0;
    });
    observer.observe(contentRef);
    return () => observer.disconnect();
  });

  // Column resize composable
  const columnResize = useColumnResize(undefined, () => settingsStore.columnVisibility);

  // Column header context menu state
  let columnMenuPos = $state<{ x: number; y: number } | null>(null);

  function handleColumnHeaderContextMenu(event: MouseEvent) {
    event.preventDefault();
    columnMenuPos = { x: event.clientX, y: event.clientY };
  }

  function closeColumnMenu() {
    columnMenuPos = null;
  }


  // Marquee selection composable
  const marquee = useMarqueeSelection();

  // Type-ahead selection composable
  const typeAhead = useTypeAhead(
    () => explorer.displayEntries,
    (entry) => explorer.selectEntry(entry, {}),
  );

  // Inline new folder creation
  let newFolderName = $state("New folder");
  let newFolderInput: HTMLInputElement | null = null;
  let newFolderError = $state<string | null>(null);

  /** Compute next available "New folder" / "New folder 2" / etc. */
  function getNextFolderName(): string {
    const base = "New folder";
    const existingNames = new Set(
      explorer.displayEntries
        .filter((e) => e.kind === "directory")
        .map((e) => e.name.toLowerCase())
    );
    if (!existingNames.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base} ${i}`;
      if (!existingNames.has(candidate.toLowerCase())) return candidate;
    }
  }

  $effect(() => {
    if (explorer.isCreatingFolder && newFolderInput) {
      newFolderName = getNextFolderName();
      newFolderError = null;
      tick().then(() => {
        newFolderInput?.focus();
        newFolderInput?.select();
      });
    }
  });

  async function confirmNewFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (!name) {
      explorer.cancelInlineNewFolder();
      return;
    }
    const error = await explorer.createFolder(name);
    if (error) {
      newFolderError = error;
    }
  }

  function handleNewFolderKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmNewFolder();
    } else if (event.key === "Escape") {
      event.preventDefault();
      explorer.cancelInlineNewFolder();
    }
  }

  // Progressive rendering for tiles view to avoid UI freeze
  const TILE_CHUNK = 60;
  let tileRenderLimit = $state(TILE_CHUNK);
  let tileRafId: number | null = null;

  // Reset and progressively render tiles when entries or view mode change
  $effect(() => {
    // Track dependencies
    const entries = explorer.displayEntries;
    const mode = explorer.viewMode;

    if (tileRafId) cancelAnimationFrame(tileRafId);

    if (mode !== "tiles" || entries.length <= TILE_CHUNK) {
      tileRenderLimit = entries.length;
      return;
    }

    tileRenderLimit = TILE_CHUNK;

    function renderMore() {
      tileRenderLimit = Math.min(tileRenderLimit + TILE_CHUNK, entries.length);
      if (tileRenderLimit < entries.length) {
        tileRafId = requestAnimationFrame(renderMore);
      }
    }
    tileRafId = requestAnimationFrame(renderMore);

    return () => {
      if (tileRafId) cancelAnimationFrame(tileRafId);
    };
  });

  const visibleTileEntries = $derived(
    explorer.displayEntries.slice(0, tileRenderLimit)
  );

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
      const result = isImageFile(entry)
        ? await openImageWithSiblings(entry.path)
        : await openFile(entry.path);
      if (result.ok) {
        recentFilesStore.add(entry.path, entry.name, "file");
      } else {
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

  /** Header height for marquee clamping: 32px for details (column headers), 0 for list/tiles */
  function marqueeHeaderHeight(): number {
    return explorer.viewMode === "details" ? 32 : 0;
  }

  function handleMarqueeStart(event: MouseEvent): void {
    const rect = contentRef?.getBoundingClientRect();
    if (!rect) return;
    marquee.start(event, rect, marqueeHeaderHeight());
  }

  function handleMarqueeMove(event: MouseEvent): void {
    const rect = contentRef?.getBoundingClientRect();
    if (!rect) return;
    if (!marquee.move(event, rect, marqueeHeaderHeight())) return;
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

    let indices: number[];
    if (explorer.viewMode === "tiles") {
      // Tiles use CSS grid - need DOM-based hit testing
      indices = marquee.getSelectedIndicesFromDOM(contentRef, ".tile-item");
    } else if (explorer.viewMode === "list") {
      // List view has variable item height and no column headers - use DOM-based hit testing
      indices = marquee.getSelectedIndicesFromDOM(contentRef, ".list-item");
    } else {
      const scrollTop = contentRef.querySelector('.virtual-viewport')?.scrollTop ?? 0;
      indices = marquee.getSelectedIndices(scrollTop, explorer.displayEntries.length);
    }
    explorer.selectByIndices(indices, marquee.ctrlKeyHeld);
  }

  function handleBackgroundContextMenu(event: MouseEvent): void {
    if (marquee.isBackgroundClick(event.target as HTMLElement)) {
      event.preventDefault();
      explorer.clearSelection();
      explorer.openContextMenu(event.clientX, event.clientY);
    }
  }

  /** Context menu handler for list/tiles items (Details view uses FileItem's own handler) */
  function handleItemContextMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault();
    event.stopPropagation();
    if (!explorer.isSelected(entry)) {
      explorer.selectEntry(entry, {});
    }
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  // ===================
  // Drag handlers for list/tiles views (Details view uses FileItem's own handlers)
  // ===================

  /** Per-entry drop target state, keyed by path */
  let dropTargets = $state<Record<string, boolean>>({});
  let copyDropTargets = $state<Record<string, boolean>>({});

  function handleItemDragEnd(): void {
    dragState.clear();
    paneNav?.refreshAllPanes();
  }

  function handleItemDragStart(event: DragEvent, entry: FileEntry): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData("application/x-explorer-path", entry.path);
    event.dataTransfer.setData("application/x-explorer-name", entry.name);
    event.dataTransfer.setData("application/x-explorer-kind", entry.kind);
    event.dataTransfer.effectAllowed = "all";
    dragState.start({ path: entry.path, name: entry.name, kind: entry.kind });
  }

  function handleItemDragOver(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    // Accept if dataTransfer has our type, OR if there's cross-window drag data
    if (!event.dataTransfer?.types.includes("application/x-explorer-path") && !dragState.readCrossWindow()) return;
    event.preventDefault();
    const copying = event.ctrlKey;
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    dropTargets[entry.path] = true;
    copyDropTargets[entry.path] = copying;
  }

  function handleItemDragLeave(entry: FileEntry): void {
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;
  }

  async function handleItemDrop(event: DragEvent, entry: FileEntry): Promise<void> {
    event.preventDefault();
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;
    if (entry.kind !== "directory" || !event.dataTransfer) return;

    // Try dataTransfer first, fall back to cross-window drag state
    let sourcePath = event.dataTransfer.getData("application/x-explorer-path");
    if (!sourcePath) {
      const crossWindow = dragState.readCrossWindow();
      if (crossWindow) sourcePath = crossWindow.path;
    }
    if (!sourcePath || sourcePath === entry.path) return;
    if (entry.path.startsWith(sourcePath + "/")) return;

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
      paneNav?.refreshAllPanes();
      broadcastFileChange([parentDir(sourcePath), entry.path]);
    } else {
      console.error(`Failed to ${isCopyOp ? "copy" : "move"}:`, result.error);
      toastStore.error(result.error);
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    typeAhead.handleKeydown(event);
  }

  // Drop handlers for dropping files into current directory
  function handleListDragOver(event: DragEvent): void {
    // Accept if dataTransfer has our type, OR if there's cross-window drag data
    if (!event.dataTransfer?.types.includes("application/x-explorer-path") && !dragState.readCrossWindow()) return;

    // Check if target is a file item (let FileItem handle its own drops)
    const target = event.target as HTMLElement;
    if (target.closest(".file-item")) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
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

    // Try dataTransfer first, fall back to cross-window drag state
    let sourcePath = event.dataTransfer.getData("application/x-explorer-path");
    if (!sourcePath) {
      const crossWindow = dragState.readCrossWindow();
      if (crossWindow) sourcePath = crossWindow.path;
    }
    if (!sourcePath) return;

    // Don't allow dropping into the same directory it's already in
    const currentPath = explorer.currentPath;
    const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
    if (sourceDir === currentPath) return;

    event.preventDefault();

    const fileName = sourcePath.split("/").pop() || sourcePath;

    // Check for naming conflict in current directory
    let overwrite = false;
    const existingNames = new Set(explorer.displayEntries.map((e) => e.name));
    if (existingNames.has(fileName)) {
      const { choice } = await conflictResolver.prompt({
        fileName,
        sourcePath,
        remaining: 0,
      });
      if (choice === "skip" || choice === "cancel") return;
      if (choice === "overwrite") overwrite = true;
    }

    const result = await moveEntry(sourcePath, currentPath, overwrite);
    if (result.ok) {
      const destName = currentPath.split("/").pop() || currentPath;
      undoStore.push({
        type: "move",
        sourcePath,
        destPath: result.data.path,
        originalDir: sourceDir,
      });
      toastStore.show(`Moved ${fileName} to ${destName}`, "info");
      if (paneNav) {
        paneNav.refreshAllPanes();
      } else {
        explorer.refresh();
      }
      broadcastFileChange([parentDir(sourcePath), currentPath]);
    } else {
      console.error("Failed to move:", result.error);
      toastStore.error(result.error);
    }
  }
</script>

<!-- Global mouse events for marquee and column resize -->
<svelte:window
  onmousemove={(e) => { handleMarqueeMove(e); columnResize.handleResize(e); }}
  onmouseup={() => { handleMarqueeEnd(); columnResize.endResize(); }}
  onblur={() => { if (marquee.isDragging) marquee.end(); }}
  onpointercancel={() => { if (marquee.isDragging) marquee.end(); }}
  ondragstart={() => { if (marquee.isDragging) marquee.end(); }}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="file-list" onkeydown={handleKeydown} onclick={handleBackgroundClick} oncontextmenu={handleBackgroundContextMenu} tabindex="-1">
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
    {#if explorer.loading}
      <div class="status">
        <div class="spinner"></div>
        <span>Loading...</span>
      </div>
    {:else if explorer.error}
      <div class="status error-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <path d="M24 16V26M24 32V30" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="error-title">Unable to access folder</span>
        <span class="error-message">{explorer.error}</span>
      </div>
    {:else if explorer.displayEntries.length === 0}
      <div class="status empty-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path d="M8 16C8 13.7909 9.79086 12 12 12H19.1716C19.702 12 20.2107 12.2107 20.5858 12.5858L23 15H36C38.2091 15 40 16.7909 40 19V34C40 36.2091 38.2091 38 36 38H12C9.79086 38 8 36.2091 8 34V16Z" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <path d="M20 27H28" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
        </svg>
        <span>This folder is empty</span>
      </div>
    {:else if explorer.viewMode === "details"}
      <!-- Details View with Column Headers -->
      <div class="details-view" class:resizing={columnResize.isResizing} style="--col-name: {columnResize.columnWidths.name}px; --col-date: {columnResize.columnWidths.date}px; --col-type: {columnResize.columnWidths.type}px; --col-size: {columnResize.columnWidths.size}px; --details-grid-columns: {columnResize.gridTemplateColumns};">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="column-headers" style="grid-template-columns: {columnResize.gridTemplateColumns};" oncontextmenu={handleColumnHeaderContextMenu}>
          <div class="column-header-wrapper">
            <button
              class="column-header name-column"
              onclick={() => explorer.setSorting("name")}
              class:active={explorer.sortBy === "name"}
            >
              <span>Name</span>
              {#if explorer.sortBy === "name"}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                  {#if explorer.sortAscending}
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
          {#if settingsStore.columnVisibility.date}
          <div class="column-header-wrapper">
            <button
              class="column-header date-column"
              onclick={() => explorer.setSorting("modified")}
              class:active={explorer.sortBy === "modified"}
            >
              <span>Date modified</span>
              {#if explorer.sortBy === "modified"}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                  {#if explorer.sortAscending}
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
          {/if}
          {#if settingsStore.columnVisibility.type}
          <div class="column-header-wrapper">
            <div class="column-header type-column">
              <span>Type</span>
            </div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("type", e)}></div>
          </div>
          {/if}
          {#if settingsStore.columnVisibility.size}
          <div class="column-header-wrapper">
            <button
              class="column-header size-column"
              onclick={() => explorer.setSorting("size")}
              class:active={explorer.sortBy === "size"}
            >
              <span>Size</span>
              {#if explorer.sortBy === "size"}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                  {#if explorer.sortAscending}
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
          {/if}
        </div>

        <!-- Column visibility context menu -->
        {#if columnMenuPos}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="column-menu-backdrop" onclick={closeColumnMenu} oncontextmenu={(e) => { e.preventDefault(); closeColumnMenu(); }}></div>
          <div class="column-menu" style="left: {columnMenuPos.x}px; top: {columnMenuPos.y}px;">
            <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("date"); closeColumnMenu(); }}>
              <span class="column-menu-check">{settingsStore.columnVisibility.date ? "✓" : ""}</span>
              Date modified
            </button>
            <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("type"); closeColumnMenu(); }}>
              <span class="column-menu-check">{settingsStore.columnVisibility.type ? "✓" : ""}</span>
              Type
            </button>
            <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("size"); closeColumnMenu(); }}>
              <span class="column-menu-check">{settingsStore.columnVisibility.size ? "✓" : ""}</span>
              Size
            </button>
          </div>
        {/if}

        {#if explorer.isCreatingFolder}
          <div class="inline-new-folder">
            <span class="new-folder-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="#ffb900"/>
              </svg>
            </span>
            <input
              type="text"
              class="new-folder-input"
              bind:value={newFolderName}
              bind:this={newFolderInput}
              onkeydown={handleNewFolderKeydown}
              onblur={() => confirmNewFolder()}
              class:error={newFolderError !== null}
            />
            {#if newFolderError}
              <span class="new-folder-error">{newFolderError}</span>
            {/if}
          </div>
        {/if}

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
    {:else if explorer.viewMode === "list"}
      <!-- Compact List View -->
      {@const totalItems = explorer.displayEntries.length + (explorer.isCreatingFolder ? 1 : 0)}
      {@const listRows = Math.ceil(totalItems / effectiveListColumns)}
      <div class="list-view file-rows" style="--list-columns: {effectiveListColumns}; --list-rows: {listRows};">
        {#if explorer.isCreatingFolder}
          <div class="inline-new-folder list-inline-new-folder">
            <span class="list-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="#ffb900"/>
              </svg>
            </span>
            <input
              type="text"
              class="new-folder-input"
              bind:value={newFolderName}
              bind:this={newFolderInput}
              onkeydown={handleNewFolderKeydown}
              onblur={() => confirmNewFolder()}
              class:error={newFolderError !== null}
            />
            {#if newFolderError}
              <span class="new-folder-error">{newFolderError}</span>
            {/if}
          </div>
        {/if}
        {#each explorer.displayEntries as entry (entry.path)}
          <button
            class="list-item"
            class:directory={entry.kind === "directory"}
            class:selected={explorer.isSelected(entry)}
            class:drop-target={dropTargets[entry.path]}
            class:copy-drop={copyDropTargets[entry.path]}
            draggable="true"
            onclick={(e) => handleClick(entry, e)}
            ondblclick={() => handleDoubleClick(entry)}
            oncontextmenu={(e) => handleItemContextMenu(e, entry)}
            ondragstart={(e) => handleItemDragStart(e, entry)}
            ondragend={handleItemDragEnd}
            ondragover={(e) => handleItemDragOver(e, entry)}
            ondragleave={() => handleItemDragLeave(entry)}
            ondrop={(e) => handleItemDrop(e, entry)}
          >
            <span class="list-icon" style:color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined}>
              <FileIcon {entry} size="small" />
            </span>
            <span class="list-name">{entry.name}</span>
          </button>
        {/each}

      </div>
    {:else}
      <!-- Tiles View (Grid) - progressively rendered to avoid UI freeze -->
      <div class="tiles-view file-rows">
        {#if explorer.isCreatingFolder}
          <div class="tile-item tile-inline-new-folder">
            <div class="tile-icon">
              <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
                <path d="M4 14C4 11.79 5.79 10 8 10H16.34C17.4 10 18.42 10.42 19.17 11.17L22 14H40C42.21 14 44 15.79 44 18V37C44 39.21 42.21 41 40 41H8C5.79 41 4 39.21 4 37V14Z" fill="#e8a800"/>
                <path d="M2 22C2 20.34 3.34 19 5 19H43C44.66 19 46 20.34 46 22V39C46 40.66 44.66 42 43 42H5C3.34 42 2 40.66 2 39V22Z" fill="#f0b400"/>
              </svg>
            </div>
            <input
              type="text"
              class="new-folder-input tile-new-folder-input"
              bind:value={newFolderName}
              bind:this={newFolderInput}
              onkeydown={handleNewFolderKeydown}
              onblur={() => confirmNewFolder()}
              class:error={newFolderError !== null}
            />
            {#if newFolderError}
              <span class="new-folder-error">{newFolderError}</span>
            {/if}
          </div>
        {/if}
        {#each visibleTileEntries as entry (entry.path)}
          {@const iconColor = getFileIconColor(entry)}
          <button
            class="tile-item"
            class:directory={entry.kind === "directory"}
            class:selected={explorer.isSelected(entry)}
            class:drop-target={dropTargets[entry.path]}
            class:copy-drop={copyDropTargets[entry.path]}
            draggable="true"
            onclick={(e) => handleClick(entry, e)}
            ondblclick={() => handleDoubleClick(entry)}
            oncontextmenu={(e) => handleItemContextMenu(e, entry)}
            ondragstart={(e) => handleItemDragStart(e, entry)}
            ondragend={handleItemDragEnd}
            ondragover={(e) => handleItemDragOver(e, entry)}
            ondragleave={() => handleItemDragLeave(entry)}
            ondrop={(e) => handleItemDrop(e, entry)}
          >
            <div class="tile-icon" style:color={iconColor}>
              {#if isImageFile(entry)}
                <ThumbnailImage path={entry.path} size={64} fallbackColor={iconColor} />
              {:else}
                <FileIcon {entry} size="large" />
              {/if}
            </div>
            <span class="tile-name" title={entry.name}>{entry.name}</span>
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

  <!-- Toast notifications (bottom-right floating) -->
  {#each toastStore.toasts as toast (toast.id)}
    <div class="toast {toast.type}" class:cut={toast.isCut} role={toast.type === "error" ? "alert" : "status"}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        {#if toast.type === "clipboard" && toast.isCut}
          <path d="M6 3L3 6L6 9M10 3L13 6L10 9M4 6H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        {:else if toast.type === "clipboard"}
          <path d="M4 4H12M4 4V12C4 12.5523 4.44772 13 5 13H11C11.5523 13 12 12.5523 12 12V4M4 4L5 2H11L12 4M7 7V10M9 7V10" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        {:else if toast.type === "error"}
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
          <path d="M8 5V8.5M8 11V10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        {:else}
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
          <path d="M5.5 8L7 9.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        {/if}
      </svg>
      <span>{toast.message}{#if toast.type === "clipboard"} — Ctrl+V to paste{/if}</span>
    </div>
  {/each}
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
    overflow: auto;
    position: relative;
    background: var(--content-bg, radial-gradient(ellipse at 50% 0%, var(--subtle-fill-secondary, rgba(0, 0, 0, 0.02)) 0%, transparent 70%));
    transition: background var(--transition-fast), box-shadow var(--transition-fast);
  }

  .content.drop-target {
    background: rgba(0, 120, 212, 0.08);
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  /* Marquee selection rectangle */
  .marquee-rect {
    position: absolute;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
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
    min-width: fit-content;
  }

  .column-headers {
    display: grid;
    gap: 0;
    padding: 6px 16px;
    background: var(--background-solid);
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
    font-size: var(--font-size-caption);
    font-weight: var(--font-weight-semibold);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
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

  /* Clipboard toast */
  .toast.clipboard {
    color: var(--accent);
  }

  .toast.clipboard.cut {
    color: var(--system-caution);
  }

  /* Toast notifications */
  .toast {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 100;
    background: var(--background-acrylic);
    backdrop-filter: blur(20px);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-pill);
    font-size: var(--font-size-caption);
    padding: var(--spacing-sm) var(--spacing-lg);
    box-shadow: var(--shadow-tooltip);
    animation: toastIn 200ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes toastIn {
    from {
      opacity: 0;
      transform: translateY(8px);
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
    display: grid;
    grid-template-rows: repeat(var(--list-rows, 1), auto);
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 4px;
    padding: 8px;
    overflow-y: auto;
    flex: 1;
    align-content: start;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-left-width: var(--selection-indicator-width);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }

  .list-item:focus {
    outline: none;
  }

  .list-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .list-item.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .list-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .list-item.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
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
    grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
    grid-auto-rows: min-content;
    align-content: start;
    gap: 6px;
    padding: 12px;
    overflow-y: auto;
    flex: 1;
  }

  .tile-item:focus {
    outline: none;
  }

  .tile-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 8px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-bottom-width: var(--selection-indicator-width);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: center;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    transition: background 120ms ease, border-color 120ms ease;
    height: fit-content;
    min-width: 0;
  }

  .tile-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .tile-item:active {
    transform: scale(0.97);
  }

  .tile-item.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-bottom-color: var(--accent);
    border-radius: var(--radius-md) var(--radius-md) 2px 2px;
  }

  .tile-item.selected:hover {
    background: var(--subtle-fill-tertiary);
  }

  .tile-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .tile-item.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
  }

  .tile-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
  }

  .tile-name {
    width: 100%;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    text-overflow: ellipsis;
    white-space: normal;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    padding-top: 1px;
  }

  /* Inline new folder creation */
  .inline-new-folder {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    background: var(--accent-light);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .new-folder-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .new-folder-input {
    flex: 1;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--accent);
    border-radius: 3px;
    background: var(--control-fill);
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    outline: none;
  }

  .new-folder-input.error {
    border-color: #c42b1c;
  }

  .new-folder-error {
    font-size: 11px;
    color: #c42b1c;
    white-space: nowrap;
  }

  /* List view inline new folder */
  .list-inline-new-folder {
    padding: 4px 8px;
    height: auto;
  }

  .list-inline-new-folder .list-icon {
    display: flex;
    align-items: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  /* Tiles view inline new folder */
  .tile-inline-new-folder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 6px 8px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-radius: 6px;
    height: fit-content;
  }

  .tile-new-folder-input {
    width: 100%;
    text-align: center;
    font-size: 11px;
  }

  /* Column visibility context menu */
  .column-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .column-menu {
    position: fixed;
    z-index: 100;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout);
    padding: 4px;
    min-width: 160px;
  }

  .column-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--font-size-body);
    cursor: pointer;
    text-align: left;
  }

  .column-menu-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .column-menu-check {
    width: 16px;
    text-align: center;
    color: var(--accent);
    font-size: 12px;
  }

</style>
