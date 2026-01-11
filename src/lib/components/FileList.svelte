<!--
  FileList component - displays list of file entries.
  Issue: tauri-explorer-iw0
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";
  import FileItem from "./FileItem.svelte";

  function handleClick(entry: { kind: string; path: string }) {
    if (entry.kind === "directory") {
      explorer.navigateTo(entry.path);
    }
  }
</script>

<div class="file-list">
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
</style>
