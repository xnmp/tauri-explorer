<!--
  Toolbar component - navigation and view controls.
  Issue: tauri-explorer-iw0
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";
</script>

<div class="toolbar">
  <div class="nav-buttons">
    <button onclick={() => explorer.goUp()} title="Go up">
      <span>↑</span>
    </button>
  </div>

  <div class="spacer"></div>

  <div class="view-controls">
    <button
      onclick={() => explorer.toggleHidden()}
      class:active={explorer.state.showHidden}
      title="Toggle hidden files"
    >
      {explorer.state.showHidden ? "Hide" : "Show"} hidden
    </button>

    <div class="sort-controls">
      <span class="sort-label">Sort:</span>
      <button
        onclick={() => explorer.setSorting("name")}
        class:active={explorer.state.sortBy === "name"}
      >
        Name {explorer.state.sortBy === "name" ? (explorer.state.sortAscending ? "↑" : "↓") : ""}
      </button>
      <button
        onclick={() => explorer.setSorting("size")}
        class:active={explorer.state.sortBy === "size"}
      >
        Size {explorer.state.sortBy === "size" ? (explorer.state.sortAscending ? "↑" : "↓") : ""}
      </button>
      <button
        onclick={() => explorer.setSorting("modified")}
        class:active={explorer.state.sortBy === "modified"}
      >
        Date {explorer.state.sortBy === "modified" ? (explorer.state.sortAscending ? "↑" : "↓") : ""}
      </button>
    </div>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--surface, #f5f5f5);
    border-bottom: 1px solid var(--border, #e0e0e0);
  }

  .nav-buttons {
    display: flex;
    gap: 4px;
  }

  .spacer {
    flex: 1;
  }

  .view-controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .sort-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .sort-label {
    font-size: 12px;
    color: var(--text-secondary, #666);
    margin-right: 4px;
  }

  button {
    background: none;
    border: 1px solid var(--border, #e0e0e0);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary, #1a1a1a);
    transition: background 0.1s;
  }

  button:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
  }

  button:focus {
    outline: 2px solid var(--focus-ring, #0078d4);
    outline-offset: -2px;
  }

  button.active {
    background: var(--active-bg, rgba(0, 120, 212, 0.1));
    border-color: var(--focus-ring, #0078d4);
    color: var(--focus-ring, #0078d4);
  }
</style>
