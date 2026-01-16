<!--
  NavigationBar component - Pane-specific breadcrumbs bar
  Contains only breadcrumbs for the pane. Shared controls are in SharedToolbar.
-->
<script lang="ts">
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";

  interface Props {
    explorer?: ExplorerInstance;
  }

  let { explorer = defaultExplorer }: Props = $props();

  let editingPath = $state(false);
  let editedPath = $state("");
  let pathInputRef: HTMLInputElement | null = null;

  function startPathEdit() {
    editedPath = explorer.state.currentPath;
    editingPath = true;
    // Focus input after DOM update
    setTimeout(() => pathInputRef?.select(), 0);
  }

  function cancelPathEdit() {
    editingPath = false;
    editedPath = "";
  }

  function confirmPathEdit() {
    if (editedPath.trim()) {
      explorer.navigateTo(editedPath.trim());
    }
    editingPath = false;
    editedPath = "";
  }

  function handlePathKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmPathEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelPathEdit();
    }
  }

  function copyPathToClipboard() {
    navigator.clipboard.writeText(explorer.state.currentPath);
  }
</script>

<div class="navigation-bar">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="breadcrumbs-container" class:editing={editingPath} onclick={editingPath ? undefined : startPathEdit}>
    {#if editingPath}
      <!-- Editable path input -->
      <input
        type="text"
        class="path-input"
        bind:value={editedPath}
        bind:this={pathInputRef}
        onkeydown={handlePathKeydown}
        onblur={cancelPathEdit}
        placeholder="Enter path..."
      />
    {:else}
      <!-- Breadcrumb view - start with root -->
      <button class="crumb root" onclick={(e) => { e.stopPropagation(); explorer.navigateTo("/"); }} aria-label="Root">
        /
      </button>

      {#each explorer.breadcrumbs as segment, i (segment.path)}
        <span class="chevron">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 2L6 5L3 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <button
          class="crumb"
          class:current={i === explorer.breadcrumbs.length - 1}
          onclick={(e) => { e.stopPropagation(); explorer.navigateTo(segment.path); }}
        >
          {segment.name}
        </button>
      {/each}

      <button class="dropdown-toggle" onclick={(e) => { e.stopPropagation(); copyPathToClipboard(); }} title="Copy path to clipboard" aria-label="Copy path">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="4" y="4" width="6" height="7" rx="1" stroke="currentColor" stroke-width="1"/>
          <path d="M8 4V2.5C8 2.22386 7.77614 2 7.5 2H3C2.72386 2 2.5 2.22386 2.5 2.5V8C2.5 8.27614 2.72386 8.5 3 8.5H4" stroke="currentColor" stroke-width="1"/>
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .navigation-bar {
    display: flex;
    align-items: center;
    padding: 4px 8px;
    background: var(--background-card-secondary);
    border-bottom: 1px solid var(--divider);
    height: 36px;
  }

  .breadcrumbs-container {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    overflow: hidden;
  }

  .breadcrumbs-container:focus-within {
    border-color: var(--accent);
    background: var(--control-fill-secondary);
  }

  .breadcrumbs-container:not(.editing) {
    cursor: text;
  }

  .breadcrumbs-container:not(.editing):hover {
    background: var(--control-fill-secondary);
  }

  .path-input {
    flex: 1;
    height: 100%;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    outline: none;
    padding: 0;
  }

  .path-input::placeholder {
    color: var(--text-tertiary);
  }

  .crumb {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    background: transparent;
    border: none;
    border-radius: 3px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .crumb.root {
    padding: 2px 4px;
    color: var(--text-tertiary);
    font-weight: 500;
  }

  .crumb:hover {
    background: var(--subtle-fill-secondary);
  }

  .crumb:active {
    background: var(--subtle-fill-tertiary);
  }

  .crumb.current {
    font-weight: 500;
  }

  .chevron {
    display: flex;
    align-items: center;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .dropdown-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background var(--transition-fast);
    flex-shrink: 0;
    margin-left: auto;
  }

  .dropdown-toggle:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }
</style>
