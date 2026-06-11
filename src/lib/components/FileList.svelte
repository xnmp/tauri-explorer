<!--
  FileList component - View mode dispatcher with shared interaction logic.
  Issue: tauri-explorer-iw0, tauri-explorer-x25, tauri-explorer-as45, tauri-explorer-1k9k, tauri-explorer-im3m, tauri-explorer-9djf.5
-->
<script lang="ts">
  import { tick } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { recentFilesStore } from "$lib/state/recent-files.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { openFile, openImageWithSiblings } from "$lib/api/files";
  import { dragState } from "$lib/state/drag.svelte";
  import { getDropSourcePaths, handleBackgroundDrop } from "$lib/state/drop-operations";
  import { useMarqueeSelection } from "$lib/composables/use-marquee-selection.svelte";
  import { useTypeAhead } from "$lib/composables/use-type-ahead.svelte";
  import { isImageFile } from "$lib/domain/file-types";
  import { parentDir, basename } from "$lib/domain/path";
  import { rectDimToCSS } from "$lib/domain/zoom";
  import DetailsView from "./DetailsView.svelte";
  import ListView from "./ListView.svelte";
  import TilesView from "./TilesView.svelte";
  import ToastOverlay from "./ToastOverlay.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
  }

  let { explorer }: Props = $props();

  const paneNav = getPaneNavigationContext();

  // Drop target state for dropping files into current directory
  let isDropTarget = $state(false);

  // Content container ref
  let contentRef = $state<HTMLElement | null>(null);

  // VirtualList scroll method, bound from DetailsView
  let detailsScrollToIndex = $state<((index: number) => void) | undefined>();

  // Track content width for ListView auto columns
  let contentWidth = $state(0);

  // Cached container rect for the duration of a marquee drag (avoids forced layout per mousemove)
  let cachedDragRect: DOMRect | null = null;
  // Cached marquee indices to skip redundant selectByIndices calls when the covered items haven't changed
  let lastMarqueeIndices: number[] | null = null;

  $effect(() => {
    if (!contentRef) return;
    const observer = new ResizeObserver((entries) => {
      contentWidth = entries[0]?.contentRect.width ?? 0;
      if (cachedDragRect) {
        cachedDragRect = contentRef!.getBoundingClientRect();
      }
    });
    observer.observe(contentRef);
    return () => observer.disconnect();
  });

  // Marquee selection composable
  const marquee = useMarqueeSelection();

  // Type-ahead selection composable
  const typeAhead = useTypeAhead(
    () => explorer.displayEntries,
    (entry) => {
      explorer.selectEntry(entry, {});
      scrollToSelected(entry);
    },
  );

  /** Scroll the matched entry into view after type-ahead selection. */
  function scrollToSelected(entry: FileEntry): void {
    const entries = explorer.displayEntries;
    const index = entries.indexOf(entry);
    if (index < 0) return;

    if (explorer.viewMode === "details" && detailsScrollToIndex) {
      // Delegate to VirtualList which owns its scroll container
      detailsScrollToIndex(index);
      // Wait for re-render, then focus the item
      tick().then(() => {
        requestAnimationFrame(() => {
          const el = contentRef?.querySelector<HTMLElement>(".selected");
          el?.focus({ preventScroll: true });
        });
      });
    } else {
      // List/Tiles: wait for selection state to flush to DOM, then scroll
      tick().then(() => {
        const el = contentRef?.querySelector<HTMLElement>(".selected");
        if (el) {
          el.scrollIntoView({ block: "nearest" });
          el.focus({ preventScroll: true });
        }
      });
    }
  }

  // ===================
  // Shared item callbacks (passed to view components)
  // ===================

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

  // ===================
  // Background interaction handlers
  // ===================

  function handleBackgroundClick(event: MouseEvent): void {
    if (marquee.isBackgroundClick(event.target as HTMLElement) && !marquee.isDragging && !marquee.dragJustEnded) {
      explorer.clearSelection();
    }
  }

  function handleBackgroundContextMenu(event: MouseEvent): void {
    if (marquee.isBackgroundClick(event.target as HTMLElement)) {
      event.preventDefault();
      explorer.clearSelection();
      explorer.openContextMenu(event.clientX, event.clientY);
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    typeAhead.handleKeydown(event);
  }

  // ===================
  // Marquee selection
  // ===================

  /** Header height for marquee clamping: measured from DOM for details view, 0 for list/tiles */
  function marqueeHeaderHeight(): number {
    if (explorer.viewMode !== "details") return 0;
    const header = contentRef?.querySelector(".column-headers");
    if (!header) return 32;
    return rectDimToCSS(header.getBoundingClientRect().height);
  }

  function handleMarqueeStart(event: MouseEvent): void {
    const rect = contentRef?.getBoundingClientRect();
    if (!rect) return;
    cachedDragRect = rect;
    marquee.start(event, rect, marqueeHeaderHeight());
  }

  function handleMarqueeMove(event: MouseEvent): void {
    if (!cachedDragRect) return;
    marquee.move(event, cachedDragRect, marqueeHeaderHeight(), updateMarqueeSelection);
  }

  function handleMarqueeEnd(): void {
    if (marquee.isDragging) {
      updateMarqueeSelection();
    }
    marquee.end();
    cachedDragRect = null;
    lastMarqueeIndices = null;
  }

  function indicesEqual(a: number[], b: number[] | null): boolean {
    if (!b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function updateMarqueeSelection(): void {
    if (!marquee.marqueeRect || !contentRef) return;

    let indices: number[];
    if (explorer.viewMode === "tiles") {
      // The inner view element is the actual scroller (.content never overflows)
      indices = marquee.getSelectedIndicesFromDOM(contentRef, ".tile-item", contentRef.querySelector<HTMLElement>(".tiles-view"));
    } else if (explorer.viewMode === "list") {
      indices = marquee.getSelectedIndicesFromDOM(contentRef, ".list-item", contentRef.querySelector<HTMLElement>(".list-view"));
    } else {
      const scrollTop = contentRef.querySelector('.virtual-viewport')?.scrollTop ?? 0;
      indices = marquee.getSelectedIndices(scrollTop, explorer.displayEntries.length, marqueeHeaderHeight());
    }
    if (indicesEqual(indices, lastMarqueeIndices)) return;
    lastMarqueeIndices = indices;
    explorer.selectByIndices(indices, marquee.ctrlKeyHeld);
  }

  // ===================
  // Background drop handlers (dropping into current directory)
  // ===================

  function handleListDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types;
    const crossWindow = dragState.readCrossWindow();
    if (!types?.includes("application/x-explorer-path") && !types?.includes("Files") && !crossWindow) return;

    const target = event.target as HTMLElement;
    if (target.closest(".entry-item")) return;

    // Suppress highlight when all sources are already in this directory
    const dragData = dragState.current ?? crossWindow;
    if (dragData) {
      const paths = dragData.paths ?? [dragData.path];
      if (paths.every((p) => parentDir(p) === explorer.currentPath)) return;
    }

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    isDropTarget = true;
  }

  function handleListDragLeave(event: DragEvent): void {
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    if (relatedTarget && contentRef?.contains(relatedTarget)) return;
    isDropTarget = false;
  }

  async function handleListDrop(event: DragEvent): Promise<void> {
    isDropTarget = false;

    const target = event.target as HTMLElement;
    if (target.closest(".entry-item")) return;

    if (!event.dataTransfer) return;

    const sourcePaths = getDropSourcePaths(event.dataTransfer);
    if (sourcePaths.length === 0) return;

    const currentPath = explorer.currentPath;
    // Filter out sources already in this directory
    const validPaths = sourcePaths.filter((p) => {
      const sourceDir = parentDir(p);
      return sourceDir !== currentPath;
    });
    if (validPaths.length === 0) return;

    event.preventDefault();
    dragState.clear();

    const existingNames = new Set(explorer.displayEntries.map((e) => e.name));
    for (const sourcePath of validPaths) {
      await handleBackgroundDrop(sourcePath, currentPath, existingNames, {
        onRefresh: () => {
          if (paneNav) paneNav.refreshAllPanes();
          else explorer.refresh({ silent: true });
        },
      });
      // Each transferred file now exists in the target dir — later files in
      // this batch sharing its basename must trigger the conflict dialog.
      existingNames.add(basename(sourcePath));
    }
  }
</script>

<!-- Global mouse events for marquee -->
<svelte:window
  onmousemove={(e) => { handleMarqueeMove(e); }}
  onmouseup={() => { handleMarqueeEnd(); }}
  onblur={() => { if (marquee.isDragging) marquee.end(); }}
  onpointercancel={() => { if (marquee.isDragging) marquee.end(); }}
  ondragstart={() => { if (marquee.isDragging) marquee.end(); }}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="file-list" onkeydown={handleKeydown} onclick={handleBackgroundClick} oncontextmenu={handleBackgroundContextMenu} tabindex="-1">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="content"
    class:drop-target={isDropTarget}
    data-current-path={explorer.currentPath}
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
    {:else if explorer.displayEntries.length === 0 && !explorer.isCreatingFolder}
      <div class="status empty-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path d="M8 16C8 13.7909 9.79086 12 12 12H19.1716C19.702 12 20.2107 12.2107 20.5858 12.5858L23 15H36C38.2091 15 40 16.7909 40 19V34C40 36.2091 38.2091 38 36 38H12C9.79086 38 8 36.2091 8 34V16Z" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <path d="M20 27H28" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
        </svg>
        <span>This folder is empty</span>
        <button class="go-up-button" onclick={() => explorer.goBack()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Go back
        </button>
      </div>
    {:else if explorer.displayEntries.length === 0 && explorer.isCreatingFolder}
      <div class="empty-create-folder">
        <InlineNewFolder {explorer} variant="details" />
      </div>
    {:else if explorer.viewMode === "details"}
      <DetailsView
        {explorer}
        onitemclick={handleClick}
        onitemdblclick={handleDoubleClick}
        bind:scrollToIndex={detailsScrollToIndex}
      />
    {:else if explorer.viewMode === "list"}
      <ListView
        {explorer}
        {contentWidth}
        onitemclick={handleClick}
        onitemdblclick={handleDoubleClick}
      />
    {:else}
      <TilesView
        {explorer}
        onitemclick={handleClick}
        onitemdblclick={handleDoubleClick}
      />
    {/if}

    <!-- Marquee selection rectangle -->
    {#if marquee.isDragging && marquee.marqueeRect}
      <div
        class="marquee-rect"
        style="transform: translate({marquee.marqueeRect.left}px, {marquee.marqueeRect.top}px); width: {marquee.marqueeRect.width}px; height: {marquee.marqueeRect.height}px;"
      ></div>
    {/if}
  </div>

  <ToastOverlay />
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
    background: transparent;
    transition: background var(--transition-fast), box-shadow var(--transition-fast);
  }

  .content.drop-target {
    background: rgba(0, 120, 212, 0.08);
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  /* Marquee selection rectangle */
  .marquee-rect {
    position: absolute;
    left: 0;
    top: 0;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border: 1px solid var(--accent);
    border-radius: 2px;
    pointer-events: none;
    z-index: 10;
    will-change: transform, width, height;
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

  .empty-create-folder {
    flex: 1;
    overflow: auto;
  }

  .go-up-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 6px 14px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-md);
    background: var(--control-fill);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .go-up-button:hover {
    background: var(--subtle-fill-secondary);
  }
</style>
