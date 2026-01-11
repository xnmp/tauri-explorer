<!--
  FileList component - displays list of file entries.
  Issue: tauri-explorer-iw0, tauri-explorer-x25
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";
  import FileItem from "./FileItem.svelte";

  let pasteError = $state<string | null>(null);

  function handleClick(entry: { kind: string; path: string }) {
    if (entry.kind === "directory") {
      explorer.navigateTo(entry.path);
    }
  }

  async function handleKeydown(event: KeyboardEvent) {
    if (event.key === "v" && (event.ctrlKey || event.metaKey)) {
      if (explorer.state.clipboard) {
        event.preventDefault();
        const error = await explorer.paste();
        pasteError = error;
        if (error) {
          setTimeout(() => (pasteError = null), 3000);
        }
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="file-list" onkeydown={handleKeydown} tabindex="-1">
  {#if explorer.state.clipboard}
    <div class="clipboard-indicator">
      {explorer.state.clipboard.operation === "cut" ? "Cut" : "Copied"}: {explorer.state.clipboard.entry.name}
      <button class="clear-btn" onclick={() => explorer.clearClipboard()}>Clear</button>
    </div>
  {/if}
  {#if pasteError}
    <div class="status error">{pasteError}</div>
  {/if}
  {#if explorer.state.loading}
    <div class="status loading">Loading...</div>
  {:else if explorer.state.error}
    <div class="status error">{explorer.state.error}</div>
  {:else if explorer.displayEntries.length === 0}
    <div class="status empty">Empty directory</div>
  {:else}
    {#each explorer.displayEntries as entry (entry.path)}
      <FileItem {entry} onclick={() => handleClick(entry)} />
    {/each}
  {/if}
</div>

<style>
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    flex: 1;
    overflow-y: auto;
  }

  .status {
    padding: 32px 16px;
    text-align: center;
    color: var(--text-secondary, #666);
    font-size: 14px;
  }

  .error {
    color: var(--error, #d32f2f);
  }

  .clipboard-indicator {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--active-bg, rgba(0, 120, 212, 0.1));
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-secondary, #666);
  }

  .clear-btn {
    padding: 2px 8px;
    border: 1px solid var(--border, #e0e0e0);
    border-radius: 4px;
    background: transparent;
    font-size: 11px;
    cursor: pointer;
  }

  .clear-btn:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.04));
  }
</style>
