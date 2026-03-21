<!--
  MillerColumns - Ancestor directory columns panel (Finder-style).
  Issue: feat/miller-view

  Sits to the LEFT of the main file list in any view mode.
  Shows 1-3 ancestor directory listings. Clicking a directory
  navigates into it. Controlled by settingsStore.millerLayers (0=off).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { fetchDirectory } from "$lib/api/files";
  import FileIcon from "./FileIcon.svelte";
  import type { FileEntry } from "$lib/domain/file";

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
      const entries = result.data.entries
        .sort((a, b) => a.name.localeCompare(b.name));
      rawCache.set(path, entries);
      rawColumns = rawColumns.map((col) =>
        col.path === path ? { ...col, entries, loading: false } : col
      );
    }
  }

  function handleClick(entry: FileEntry): void {
    explorer.navigateTo(entry.path);
  }
</script>

{#if columns.length > 0}
  <div class="miller-columns">
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
  </div>
{/if}

<style>
  .miller-columns {
    display: flex;
    flex-shrink: 0;
    overflow: hidden;
    border-right: 1px solid var(--divider);
    background: var(--miller-bg, var(--background-card-secondary));
  }

  .miller-col {
    display: flex;
    flex-direction: column;
    width: 200px;
    min-width: 160px;
    border-right: 1px solid var(--divider);
    overflow: hidden;
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
    padding: 2px 0;
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
    gap: 6px;
    width: 100%;
    padding: 3px 8px;
    background: transparent;
    border: none;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    min-height: 26px;
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
