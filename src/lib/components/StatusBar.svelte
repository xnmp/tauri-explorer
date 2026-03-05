<!--
  StatusBar component - Bottom status information bar
  Issue: tauri-on1c

  Shows file count, selected items, and current path info.
  Toggleable with Alt+M U.
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { formatSize } from "$lib/domain/file";

  const explorer = $derived(windowTabsManager.getActiveExplorer());
  const entries = $derived(explorer?.displayEntries ?? []);
  const selectedCount = $derived(explorer?.selectedPaths.size ?? 0);
  const totalCount = $derived(entries.length);

  const fileCount = $derived(entries.filter((e) => e.kind === "file").length);
  const folderCount = $derived(entries.filter((e) => e.kind === "directory").length);

  const selectedSize = $derived(() => {
    if (!explorer || selectedCount === 0) return 0;
    const selectedPaths = explorer.selectedPaths;
    return entries
      .filter((e) => selectedPaths.has(e.path) && e.kind === "file")
      .reduce((sum, e) => sum + e.size, 0);
  });

  const currentPath = $derived(explorer?.currentPath ?? "");
</script>

<div class="status-bar">
  <div class="status-left">
    <span class="status-item">
      {totalCount} item{totalCount !== 1 ? "s" : ""}
      {#if folderCount > 0 && fileCount > 0}
        <span class="status-detail">({folderCount} folder{folderCount !== 1 ? "s" : ""}, {fileCount} file{fileCount !== 1 ? "s" : ""})</span>
      {/if}
    </span>
    {#if selectedCount > 0}
      <span class="status-separator">|</span>
      <span class="status-item selected-info">
        {selectedCount} selected
        {#if selectedSize() > 0}
          <span class="status-detail">({formatSize(selectedSize())})</span>
        {/if}
      </span>
    {/if}
  </div>
  <div class="status-right">
    <span class="status-path" title={currentPath}>{currentPath}</span>
  </div>
</div>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    padding: 0 16px;
    background: color-mix(in srgb, var(--background-card-secondary) calc(var(--statusbar-opacity, 1) * 100%), transparent);
    border-top: none;
    box-shadow: 0 -1px 0 var(--divider);
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
    flex-shrink: 0;
    user-select: none;
    z-index: 1;
  }

  .status-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .status-right {
    display: flex;
    align-items: center;
    min-width: 0;
    flex-shrink: 1;
  }

  .status-item {
    white-space: nowrap;
  }

  .status-detail {
    color: var(--text-tertiary);
  }

  .status-separator {
    color: var(--text-tertiary);
    opacity: 0.5;
  }

  .selected-info {
    color: var(--accent);
  }

  .status-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-tertiary);
    font-family: inherit;
    direction: rtl;
    text-align: right;
  }
</style>
