<!--
  MillerColumns - Ancestor directory columns panel (Finder-style).
  Issue: feat/miller-view

  Sits to the LEFT of the main file list in any view mode.
  Shows 1-3 ancestor directory listings. Clicking a directory
  navigates into it. Controlled by the pane's explorer.millerLayers
  (0=off; per-pane since #229, defaulting from settings).
-->
<script lang="ts">
  import { untrack, onMount } from "svelte";
import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { fetchDirectory, isDirectoryEmpty } from "$lib/api/files";
  import { createDirectoryWatch } from "$lib/state/directory-watch";
  import FileIcon from "./FileIcon.svelte";
  import EntryName from "./EntryName.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { useDropTarget } from "$lib/composables/use-drop-target.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { getDropSourcePaths, handleFileDropMany } from "$lib/state/drop-operations";
  import { isCopyModifier, usesPointerDrag, usesHtml5Drag } from "$lib/domain/platform";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { parentDir } from "$lib/domain/path";
  import { subscribeToLocalFileChanges } from "$lib/state/file-events";
  import type { FileEntry } from "$lib/domain/file";
  import { isSystemHidden } from "$lib/domain/file";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";

  interface Props {
    explorer: ExplorerInstance;
  }

  let { explorer }: Props = $props();

  interface MillerColumn {
    path: string;
    name: string;
    entries: FileEntry[];
    loading: boolean;
    activeChildPath: string | null;
  }

  // Cache stores raw (unfiltered) directory entries; filtering is derived reactively.
  // Bounded: oldest non-visible directories are evicted beyond MAX_RAW_CACHE.
  const MAX_RAW_CACHE = 50;
  const rawCache = new Map<string, FileEntry[]>();

  function cacheRawEntries(path: string, entries: FileEntry[]): void {
    // Re-insert to refresh recency (Map preserves insertion order)
    rawCache.delete(path);
    rawCache.set(path, entries);
    if (rawCache.size <= MAX_RAW_CACHE) return;
    for (const key of rawCache.keys()) {
      if (rawCache.size <= MAX_RAW_CACHE) break;
      if (rawColumns.some((col) => col.path === key)) continue;
      rawCache.delete(key);
    }
  }
  let rawColumns = $state<MillerColumn[]>([]);
  const watchedPaths = new Map<string, ReturnType<typeof createDirectoryWatch>>();

  // Cache of `path -> isEmpty` keyed by the (path, showHidden) combination.
  // Repopulated when showHidden changes via clearEmptyCache().
  let emptyCache = $state(new Map<string, boolean>());
  let emptyCacheKey = "";

  function filterEntries(entries: FileEntry[], columnPath: string, activeChildPath: string | null): FileEntry[] {
    const hideEmpty = settingsStore.millerHideEmpty;
    return entries.filter((e) => {
      if (e.kind !== "directory") return false;
      if (!settingsStore.showHidden && (e.name.startsWith(".") || e.name.startsWith("~$") || isSystemHidden(e.name))) return false;
      if (!settingsStore.showManuallyHidden && manualHiddenStore.isHidden(columnPath, e.name)) return false;
      if (hideEmpty && e.path !== activeChildPath) {
        const known = emptyCache.get(e.path);
        if (known === true) return false;
      }
      return true;
    });
  }

  // Derive displayed columns reactively so showHidden changes take effect immediately.
  const columns = $derived(
    rawColumns.map((col) => ({ ...col, entries: filterEntries(col.entries, col.path, col.activeChildPath) })),
  );

  $effect(() => {
    const key = `${settingsStore.showHidden ? 1 : 0}`;
    if (key !== emptyCacheKey) {
      emptyCacheKey = key;
      emptyCache = new Map();
    }
  });

  async function ensureEmptyFlags(entries: FileEntry[]): Promise<void> {
    const includeHidden = settingsStore.showHidden;
    const targets = entries.filter((e) => e.kind === "directory" && !emptyCache.has(e.path));
    if (targets.length === 0) return;
    const results = await Promise.all(
      targets.map(async (e) => [e.path, await isDirectoryEmpty(e.path, includeHidden)] as const),
    );
    const next = new Map(emptyCache);
    for (const [p, empty] of results) next.set(p, empty);
    emptyCache = next;
  }

  $effect(() => {
    const crumbs = explorer.breadcrumbs;
    const currentPath = explorer.currentPath;
    const layers = explorer.millerLayers;
    if (layers === 0 || crumbs.length <= 1) {
      rawColumns = [];
      for (const watch of watchedPaths.values()) void watch.destroy();
      watchedPaths.clear();
      return;
    }

    // Ancestor crumbs (everything except current directory)
    const ancestorCrumbs = crumbs.slice(0, -1);
    const startIdx = Math.max(0, ancestorCrumbs.length - layers);
    const visible = ancestorCrumbs.slice(startIdx);

    const newColumns: MillerColumn[] = visible.map((crumb, i) => {
      const nextPath = i < visible.length - 1
        ? visible[i + 1].path
        : currentPath;
      return {
        path: crumb.path,
        name: crumb.name,
        entries: rawCache.get(crumb.path) || [],
        loading: !rawCache.has(crumb.path),
        activeChildPath: nextPath,
      };
    });

    rawColumns = newColumns;

    untrack(() => {
      const desiredPaths = new Set(newColumns.map((c) => c.path));
      for (const [path, watch] of watchedPaths) {
        if (!desiredPaths.has(path)) {
          void watch.destroy();
          watchedPaths.delete(path);
        }
      }
      for (const col of newColumns) {
        if (!watchedPaths.has(col.path)) {
          const watch = createDirectoryWatch();
          watchedPaths.set(col.path, watch);
          void watch.update(col.path);
        }
        if (!rawCache.has(col.path)) {
          loadColumn(col.path);
        }
      }
    });
  });

  async function loadColumn(path: string): Promise<void> {
    const result = await fetchDirectory(path);
    if (result.ok) {
      const entries = [...result.data.entries]
        .sort((a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name));
      cacheRawEntries(path, entries);
      rawColumns = rawColumns.map((col) =>
        col.path === path ? { ...col, entries, loading: false } : col
      );
      if (settingsStore.millerHideEmpty) {
        ensureEmptyFlags(entries);
      }
    }
  }

  // When the hide-empty toggle is flipped on while columns are already loaded,
  // back-fill emptiness flags for whatever's currently visible.
  $effect(() => {
    if (!settingsStore.millerHideEmpty) return;
    untrack(() => {
      for (const col of rawColumns) {
        ensureEmptyFlags(col.entries);
      }
    });
  });

  function invalidateColumn(path: string): void {
    // Invalidate empty cache for the changed dir and its parent.
    const next = new Map(emptyCache);
    next.delete(path);
    const parent = parentDir(path);
    if (parent !== path) next.delete(parent);
    if (next.size !== emptyCache.size) emptyCache = next;

    if (!rawCache.has(path)) return;
    rawCache.delete(path);
    if (rawColumns.some((col) => col.path === path)) {
      void loadColumn(path);
    }
  }

  // Filesystem watchers cover external changes; local file operations publish
  // the same affected directories so this cache does not wait for a watcher.
  onMount(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    const unsubscribeLocalChanges = subscribeToLocalFileChanges((affectedDirs) => {
      for (const path of affectedDirs) invalidateColumn(path);
    });
    listen<{ path: string }>("directory-changed", (event) => {
      invalidateColumn(event.payload.path);
    }).then((fn) => {
      // If the component was destroyed before registration resolved,
      // unlisten immediately instead of leaking the listener.
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      unsubscribeLocalChanges();
      for (const [path, watch] of watchedPaths) {
        void watch.destroy();
      }
      watchedPaths.clear();
    };
  });

  function handleClick(entry: FileEntry): void {
    explorer.navigateTo(entry.path);
  }

  function handleContextMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault();
    event.stopPropagation();
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  function handleDragStart(event: DragEvent, entry: FileEntry): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData("application/x-explorer-path", entry.path);
    event.dataTransfer.setData("application/x-explorer-name", entry.name);
    event.dataTransfer.setData("application/x-explorer-kind", entry.kind);
    event.dataTransfer.effectAllowed = "all";
    dragState.start({ path: entry.path, name: entry.name, kind: entry.kind });
  }

  function handleDragEnd(): void {
    dragState.clear();
    windowTabsManager.refreshAllPanes();
  }

  // Shared drop-target behavior
  const dropTarget = useDropTarget({ onRefresh: () => windowTabsManager.refreshAllPanes() });

  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes() }) : null;

  // Background drop: dropping onto empty space in a column moves to that column's dir
  let bgDropColumn = $state<string | null>(null);
  let bgDropCopy = $state(false);

  function handleBgDragOver(event: DragEvent, columnPath: string): void {
    const types = event.dataTransfer?.types;
    if (!types?.includes("application/x-explorer-path") && !types?.includes("Files") && !dragState.readCrossWindow()) return;
    event.preventDefault();
    const copying = isCopyModifier(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    bgDropColumn = columnPath;
    bgDropCopy = copying;
  }

  function handleBgDragLeave(event: DragEvent, columnEl: HTMLElement): void {
    const related = event.relatedTarget as Node | null;
    if (related && columnEl.contains(related)) return;
    bgDropColumn = null;
    bgDropCopy = false;
  }

  async function handleBgDrop(event: DragEvent, columnPath: string): Promise<void> {
    event.preventDefault();
    bgDropColumn = null;
    bgDropCopy = false;
    if (!event.dataTransfer) return;

    const sourcePaths = getDropSourcePaths(event.dataTransfer);
    if (sourcePaths.length === 0) return;

    const isCopy = isCopyModifier(event);

    dragState.clear();
    const valid = sourcePaths.filter(
      (sourcePath) => sourcePath !== columnPath && !columnPath.startsWith(sourcePath + "/"),
    );
    await handleFileDropMany(valid, columnPath, isCopy, {
      onRefresh: () => windowTabsManager.refreshAllPanes(),
    });
  }

  // Resizable width
  const resize = usePersistedPanelWidth("explorer-miller-width", {
    min: 120,
    max: 600,
    default: 200,
  });
</script>

{#if columns.length > 0}
  <div class="miller-columns" class:resizing={resize.isResizing} style="width: {resize.width}px">
    {#each columns as column (column.path)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="miller-col"
        class:bg-drop-target={bgDropColumn === column.path}
        class:bg-copy-drop={bgDropColumn === column.path && bgDropCopy}
        data-path={column.path}
        ondragover={(e) => handleBgDragOver(e, column.path)}
        ondragleave={(e) => handleBgDragLeave(e, e.currentTarget as HTMLElement)}
        ondrop={(e) => handleBgDrop(e, column.path)}
      >
        <div class="col-header" title={column.path}>{column.name}</div>
        <div class="col-entries">
          {#if column.loading}
            <div class="col-loading">...</div>
          {:else}
            {#each column.entries as entry (entry.path)}
              <button
                class="col-entry entry-item directory"
                class:active={entry.path === column.activeChildPath}
                class:drop-target={dropTarget.isDropTarget(entry.path)}
                class:copy-drop={dropTarget.isCopyDrop(entry.path)}
                data-path={entry.path}
                data-kind={entry.kind}
                onclick={() => handleClick(entry)}
                oncontextmenu={(e) => handleContextMenu(e, entry)}
                draggable={usesHtml5Drag}
                ondragstart={usesHtml5Drag ? (e) => handleDragStart(e, entry) : undefined}
                ondragend={usesHtml5Drag ? handleDragEnd : undefined}
                onmousedown={usesPointerDrag ? (e) => pointerDrag!.handlePointerDown(e, entry, false) : undefined}
                ondragover={(e) => dropTarget.handleDragOver(e, entry)}
                ondragleave={(e) => dropTarget.handleDragLeave(e, entry)}
                ondrop={(e) => dropTarget.handleDrop(e, entry)}
              >
                <span class="col-icon" data-drag-icon>
                  <FileIcon {entry} size="small" />
                </span>
                <span class="col-name" data-drag-name><EntryName {entry} {explorer} variant="list" /></span>
                <svg class="col-chevron" width="7" height="7" viewBox="0 0 7 7" fill="none">
                  <path d="M2 1L5 3.5L2 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {/each}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- mouse-drag resize handle; role=separator conveys the correct semantics to AT, keyboard resize is a separate unimplemented feature -->
    <div
      class="resize-handle"
      onmousedown={resize.startResize}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize miller columns"
    ></div>
  </div>
{/if}

<style>
  .miller-columns {
    display: flex;
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
    background: var(--miller-bg, var(--background-card-secondary));
  }

  .miller-columns.resizing {
    user-select: none;
  }

  .miller-col {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    border-right: 1px solid var(--divider);
    overflow: hidden;
    transition: background 150ms;
  }

  .miller-col.bg-drop-target {
    background: rgba(0, 120, 212, 0.1);
  }

  .miller-col.bg-drop-target.bg-copy-drop {
    background: rgba(16, 185, 129, 0.1);
  }

  .resize-handle {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: ew-resize;
    background: transparent;
    z-index: 1;
    transition: background 150ms;
  }

  .resize-handle:hover,
  .miller-columns.resizing .resize-handle {
    background: var(--accent);
  }

  .miller-col:last-child {
    border-right: none;
  }

  .col-header {
    padding: 6px 8px;
    font-size: var(--font-size-caption, 10px);
    font-weight: var(--font-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide, 0.04em);
    color: var(--text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 0;
  }

  .col-entries {
    flex: 1;
    overflow-y: auto;
    padding: 0 4px 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .col-loading {
    padding: 8px;
    text-align: center;
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .col-entry {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
  }

  .col-entry:hover {
    background: var(--subtle-fill-secondary);
  }

  .col-entry.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    font-weight: 500;
  }

  .col-entry.drop-target {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .col-entry.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
  }

  .col-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
  }

  .col-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .col-chevron {
    color: var(--text-tertiary);
    flex-shrink: 0;
    opacity: 0.5;
  }

  .col-entry.active .col-chevron {
    color: var(--accent);
    opacity: 1;
  }

  /* Vibrancy: flatten inside island */
  :global([data-vibrancy]) .miller-columns {
    background: transparent;
  }
</style>
