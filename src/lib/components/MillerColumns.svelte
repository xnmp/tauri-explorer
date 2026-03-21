<!--
  MillerColumns - Ancestor directory columns panel (Finder-style).
  Issue: feat/miller-view

  Sits to the LEFT of the main file list in any view mode.
  Shows 1-3 ancestor directory listings. Clicking a directory
  navigates into it. Controlled by settingsStore.millerLayers (0=off).
-->
<script lang="ts">
  import { untrack, onMount } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { fetchDirectory } from "$lib/api/files";
  import FileIcon from "./FileIcon.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import type { FileEntry } from "$lib/domain/file";
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
  const rawCache = new Map<string, FileEntry[]>();
  let rawColumns = $state<MillerColumn[]>([]);

  function filterEntries(entries: FileEntry[]): FileEntry[] {
    return entries.filter(
      (e) => e.kind === "directory" && (settingsStore.showHidden || !e.name.startsWith(".")),
    );
  }

  // Derive displayed columns reactively so showHidden changes take effect immediately.
  const columns = $derived(
    rawColumns.map((col) => ({ ...col, entries: filterEntries(col.entries) })),
  );

  $effect(() => {
    const crumbs = explorer.breadcrumbs;
    const currentPath = explorer.currentPath;
    const layers = settingsStore.millerLayers;
    if (layers === 0 || crumbs.length <= 1) {
      rawColumns = [];
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
      for (const col of newColumns) {
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
        .filter((e: FileEntry) => e.kind === "directory")
        .sort((a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name));
      rawCache.set(path, entries);
      rawColumns = rawColumns.map((col) =>
        col.path === path ? { ...col, entries, loading: false } : col
      );
    }
  }

  // Listen for filesystem changes to invalidate stale Miller cache entries
  onMount(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ path: string }>("directory-changed", (event) => {
      const changedPath = event.payload.path;
      if (rawCache.has(changedPath)) {
        rawCache.delete(changedPath);
        // Reload the column if it's currently visible
        const isVisible = rawColumns.some((col) => col.path === changedPath);
        if (isVisible) {
          loadColumn(changedPath);
        }
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  });

  function handleClick(entry: FileEntry): void {
    explorer.navigateTo(entry.path);
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
    setTimeout(() => dragState.clear(), 0);
  }

  // Resizable width
  const MILLER_WIDTH_KEY = "explorer-miller-width";
  const MIN_WIDTH = 120;
  const MAX_WIDTH = 600;
  const DEFAULT_WIDTH = 200;

  let savedWidth = typeof localStorage !== "undefined"
    ? parseInt(localStorage.getItem(MILLER_WIDTH_KEY) || String(DEFAULT_WIDTH), 10)
    : DEFAULT_WIDTH;

  let millerWidth = $state(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, savedWidth)));
  let isResizing = $state(false);

  function startResize(event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
    const startX = event.clientX;
    const startWidth = millerWidth;

    function onMouseMove(e: MouseEvent) {
      const delta = e.clientX - startX;
      millerWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
    }

    function onMouseUp() {
      isResizing = false;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(MILLER_WIDTH_KEY, String(millerWidth));
      }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }
</script>

{#if columns.length > 0}
  <div class="miller-columns" class:resizing={isResizing} style="width: {millerWidth}px">
    {#each columns as column (column.path)}
      <div class="miller-col">
        <div class="col-header" title={column.path}>{column.name}</div>
        <div class="col-entries">
          {#if column.loading}
            <div class="col-loading">...</div>
          {:else}
            {#each column.entries as entry (entry.path)}
              <button
                class="col-entry"
                class:active={entry.path === column.activeChildPath}
                onclick={() => handleClick(entry)}
                draggable="true"
                ondragstart={(e) => handleDragStart(e, entry)}
                ondragend={handleDragEnd}
              >
                <span class="col-icon">
                  <FileIcon {entry} size="small" />
                </span>
                <span class="col-name">{entry.name}</span>
                <svg class="col-chevron" width="7" height="7" viewBox="0 0 7 7" fill="none">
                  <path d="M2 1L5 3.5L2 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {/each}
    <div
      class="resize-handle"
      onmousedown={startResize}
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
    padding: 5px 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-tertiary);
    background: var(--background-card-secondary);
    border-bottom: 1px solid var(--divider);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 0;
  }

  .col-entries {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
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
</style>
