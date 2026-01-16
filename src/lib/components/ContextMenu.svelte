<!--
  Context Menu component - Windows 11 Fluent Design
  Right-click menu for file operations
  Issue: tauri-explorer-83z
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { ViewMode } from "$lib/state/types";

  function withSelectedEntry(action: (entry: FileEntry) => void): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) {
      action(entries[0]);
    }
    explorer.closeContextMenu();
  }

  const hasSelection = $derived(explorer.state.selectedPaths.size > 0);

  function handleCut(): void {
    withSelectedEntry((entry) => explorer.cutToClipboard(entry));
  }

  function handleCopy(): void {
    withSelectedEntry((entry) => explorer.copyToClipboard(entry));
  }

  async function handlePaste(): Promise<void> {
    await explorer.paste();
    explorer.closeContextMenu();
  }

  function handleRename(): void {
    withSelectedEntry((entry) => explorer.startRename(entry));
  }

  function handleDelete(): void {
    withSelectedEntry((entry) => explorer.startDelete(entry));
  }

  function handleNewFolder(): void {
    explorer.openNewFolderDialog();
    explorer.closeContextMenu();
  }

  function handleSetViewMode(mode: ViewMode): void {
    explorer.setViewMode(mode);
    explorer.closeContextMenu();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      explorer.closeContextMenu();
    }
  }

  const viewModes: { id: ViewMode; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "list", label: "List" },
    { id: "tiles", label: "Tiles" },
  ];
</script>

<svelte:window on:keydown={handleKeydown} />

{#if explorer.state.contextMenuOpen && explorer.state.contextMenuPosition}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="context-menu-backdrop" onclick={() => explorer.closeContextMenu()}></div>

  <div
    class="context-menu"
    style="left: {explorer.state.contextMenuPosition.x}px; top: {explorer.state.contextMenuPosition.y}px;"
    role="menu"
  >
    {#if hasSelection}
      <!-- File/folder operations -->
      <button class="menu-item" onclick={handleCut} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 3L3 6L6 9M10 3L13 6L10 9M4 6H12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Cut</span>
        <span class="shortcut">Ctrl+X</span>
      </button>

      <button class="menu-item" onclick={handleCopy} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="8" height="9" rx="1" stroke="currentColor" stroke-width="1.25"/>
          <path d="M11 5V3C11 2.44772 10.5523 2 10 2H4C3.44772 2 3 2.44772 3 3V11C3 11.5523 3.44772 12 4 12H5" stroke="currentColor" stroke-width="1.25"/>
        </svg>
        <span>Copy</span>
        <span class="shortcut">Ctrl+C</span>
      </button>

      <div class="menu-divider"></div>

      <button class="menu-item" onclick={handleRename} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 11.5V13H4.5L11.5 6L10 4.5L3 11.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
          <path d="M10 4.5L11.5 3L13 4.5L11.5 6L10 4.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
        </svg>
        <span>Rename</span>
        <span class="shortcut">F2</span>
      </button>

      <button class="menu-item danger" onclick={handleDelete} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 5H12M5 5V13C5 13.5523 5.44772 14 6 14H10C10.5523 14 11 13.5523 11 13V5M6 5V3C6 2.44772 6.44772 2 7 2H9C9.55228 2 10 2.44772 10 3V5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Delete</span>
        <span class="shortcut">Del</span>
      </button>

      <div class="menu-divider"></div>
    {/if}

    <!-- Always available options -->
    {#if explorer.state.clipboard}
      <button class="menu-item" onclick={handlePaste} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="4" y="4" width="9" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
          <path d="M6 4V3C6 2.44772 6.44772 2 7 2H10C10.5523 2 11 2.44772 11 3V4" stroke="currentColor" stroke-width="1.25"/>
          <path d="M7 8H10M8.5 6.5V9.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        <span>Paste</span>
        <span class="shortcut">Ctrl+V</span>
      </button>
      <div class="menu-divider"></div>
    {/if}

    <button class="menu-item" onclick={handleNewFolder} role="menuitem">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" stroke="currentColor" stroke-width="1.25"/>
        <path d="M8 7.5V10.5M6.5 9H9.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <span>New folder</span>
    </button>

    <div class="menu-divider"></div>

    <!-- View options -->
    <div class="menu-section-label">View</div>
    {#each viewModes as mode}
      <button
        class="menu-item"
        class:selected={explorer.state.viewMode === mode.id}
        onclick={() => handleSetViewMode(mode.id)}
        role="menuitemradio"
        aria-checked={explorer.state.viewMode === mode.id}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {#if mode.id === "details"}
            <path d="M2 4H14M2 8H14M2 12H14" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          {:else if mode.id === "list"}
            <path d="M3 4H4M6 4H13M3 8H4M6 8H13M3 12H4M6 12H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          {:else}
            <rect x="2" y="2" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
            <rect x="9" y="2" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
            <rect x="2" y="9" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
            <rect x="9" y="9" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
          {/if}
        </svg>
        <span>{mode.label}</span>
        {#if explorer.state.viewMode === mode.id}
          <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .context-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 999;
  }

  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 200px;
    padding: 4px;
    background: var(--background-acrylic);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout);
    animation: menuIn 100ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes menuIn {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(-4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
  }

  .menu-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .menu-item:active {
    background: var(--subtle-fill-tertiary);
  }

  .menu-item svg {
    flex-shrink: 0;
    color: var(--text-secondary);
  }

  .menu-item span:first-of-type {
    flex: 1;
  }

  .shortcut {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .menu-item.danger {
    color: var(--system-critical);
  }

  .menu-item.danger svg {
    color: var(--system-critical);
  }

  .menu-divider {
    height: 1px;
    margin: 4px 8px;
    background: var(--divider);
  }

  .menu-section-label {
    padding: 6px 12px 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .menu-item.selected {
    background: var(--subtle-fill-tertiary);
  }

  .check-icon {
    color: var(--accent);
    margin-left: auto;
  }
</style>
