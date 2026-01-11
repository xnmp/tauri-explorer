<!--
  Breadcrumbs component - path navigation.
  Issue: tauri-explorer-iw0
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";
</script>

<nav class="breadcrumbs">
  <button onclick={() => explorer.navigateTo("/")}>Root</button>
  {#each explorer.breadcrumbs as segment (segment.path)}
    <span class="separator">/</span>
    <button onclick={() => explorer.navigateTo(segment.path)}>
      {segment.name}
    </button>
  {/each}
</nav>

<style>
  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 12px;
    background: var(--surface, #f5f5f5);
    border-bottom: 1px solid var(--border, #e0e0e0);
    overflow-x: auto;
    white-space: nowrap;
  }

  button {
    background: none;
    border: none;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary, #1a1a1a);
  }

  button:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
  }

  button:focus {
    outline: 2px solid var(--focus-ring, #0078d4);
    outline-offset: -2px;
  }

  .separator {
    color: var(--text-secondary, #999);
    font-size: 12px;
  }
</style>
