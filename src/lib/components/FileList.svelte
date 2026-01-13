<!--
  FileList component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-x25
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";
  import { openFile } from "$lib/api/files";
  import FileItem from "./FileItem.svelte";

  import type { FileEntry } from "$lib/domain/file";

  let pasteError = $state<string | null>(null);
  let pasteSuccess = $state(false);

  const BACKGROUND_CLASSES = ["file-rows", "content", "details-view"];

  function isBackgroundClick(target: HTMLElement): boolean {
    return BACKGROUND_CLASSES.some((cls) => target.classList.contains(cls));
  }

  function handleClick(entry: FileEntry): void {
    explorer.selectEntry(entry);
  }

  async function handleDoubleClick(entry: FileEntry): Promise<void> {
    if (entry.kind === "directory") {
      explorer.navigateTo(entry.path);
    } else {
      const result = await openFile(entry.path);
      if (!result.ok) {
        console.error("Failed to open file:", result.error);
      }
    }
  }

  function handleBackgroundClick(event: MouseEvent): void {
    if (isBackgroundClick(event.target as HTMLElement)) {
      explorer.clearSelection();
    }
  }

  function handleBackgroundContextMenu(event: MouseEvent): void {
    if (isBackgroundClick(event.target as HTMLElement)) {
      event.preventDefault();
      explorer.clearSelection();
      explorer.openContextMenu(event.clientX, event.clientY);
    }
  }

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    const isPasteShortcut = event.key === "v" && (event.ctrlKey || event.metaKey);

    if (isPasteShortcut && explorer.state.clipboard) {
      event.preventDefault();
      const error = await explorer.paste();

      if (error) {
        pasteError = error;
        setTimeout(() => (pasteError = null), 3000);
      } else {
        pasteSuccess = true;
        setTimeout(() => (pasteSuccess = false), 1500);
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="file-list" onkeydown={handleKeydown} onclick={handleBackgroundClick} oncontextmenu={handleBackgroundContextMenu} tabindex="-1">
  <!-- Clipboard indicator -->
  {#if explorer.state.clipboard}
    <div class="clipboard-banner" class:cut={explorer.state.clipboard.operation === "cut"}>
      <div class="clipboard-content">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {#if explorer.state.clipboard.operation === "cut"}
            <path d="M6 3L3 6L6 9M10 3L13 6L10 9M4 6H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          {:else}
            <path d="M4 4H12M4 4V12C4 12.5523 4.44772 13 5 13H11C11.5523 13 12 12.5523 12 12V4M4 4L5 2H11L12 4M7 7V10M9 7V10" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          {/if}
        </svg>
        <span class="clipboard-text">
          <strong>{explorer.state.clipboard.operation === "cut" ? "Cut" : "Copied"}:</strong>
          {explorer.state.clipboard.entry.name}
        </span>
        <span class="clipboard-hint">Ctrl+V to paste</span>
      </div>
      <button class="clipboard-clear" onclick={() => explorer.clearClipboard()} aria-label="Clear clipboard">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  {/if}

  <!-- Toast notifications -->
  {#if pasteError}
    <div class="toast error" role="alert">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M8 5V8.5M8 11V10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>{pasteError}</span>
    </div>
  {/if}

  {#if pasteSuccess}
    <div class="toast success" role="status">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M5.5 8L7 9.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Pasted successfully</span>
    </div>
  {/if}

  <!-- Main content with column headers -->
  <div class="content">
    {#if explorer.state.loading}
      <div class="status">
        <div class="spinner"></div>
        <span>Loading...</span>
      </div>
    {:else if explorer.state.error}
      <div class="status error-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <path d="M24 16V26M24 32V30" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="error-title">Unable to access folder</span>
        <span class="error-message">{explorer.state.error}</span>
      </div>
    {:else if explorer.displayEntries.length === 0}
      <div class="status empty-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path d="M8 16C8 13.7909 9.79086 12 12 12H19.1716C19.702 12 20.2107 12.2107 20.5858 12.5858L23 15H36C38.2091 15 40 16.7909 40 19V34C40 36.2091 38.2091 38 36 38H12C9.79086 38 8 36.2091 8 34V16Z" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <path d="M20 27H28" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
        </svg>
        <span>This folder is empty</span>
      </div>
    {:else}
      <!-- Details View with Column Headers -->
      <div class="details-view">
        <div class="column-headers">
          <button
            class="column-header name-column"
            onclick={() => explorer.setSorting("name")}
            class:active={explorer.state.sortBy === "name"}
          >
            <span>Name</span>
            {#if explorer.state.sortBy === "name"}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                {#if explorer.state.sortAscending}
                  <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                {:else}
                  <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                {/if}
              </svg>
            {/if}
          </button>
          <button
            class="column-header date-column"
            onclick={() => explorer.setSorting("modified")}
            class:active={explorer.state.sortBy === "modified"}
          >
            <span>Date modified</span>
            {#if explorer.state.sortBy === "modified"}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                {#if explorer.state.sortAscending}
                  <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                {:else}
                  <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                {/if}
              </svg>
            {/if}
          </button>
          <div class="column-header type-column">
            <span>Type</span>
          </div>
          <button
            class="column-header size-column"
            onclick={() => explorer.setSorting("size")}
            class:active={explorer.state.sortBy === "size"}
          >
            <span>Size</span>
            {#if explorer.state.sortBy === "size"}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
                {#if explorer.state.sortAscending}
                  <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                {:else}
                  <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                {/if}
              </svg>
            {/if}
          </button>
        </div>

        <div class="file-rows">
          {#each explorer.displayEntries as entry, i (entry.path)}
            <div class="file-row-wrapper" style="--index: {i}">
              <FileItem
                {entry}
                onclick={() => handleClick(entry)}
                ondblclick={() => handleDoubleClick(entry)}
                selected={explorer.state.selectedEntry?.path === entry.path}
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .file-list {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    position: relative;
  }

  .file-list:focus {
    outline: none;
  }

  .content {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow-y: auto;
  }

  /* Details View */
  .details-view {
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .column-headers {
    display: grid;
    grid-template-columns: 1fr 180px 160px 100px;
    gap: 8px;
    padding: 6px 16px;
    background: var(--background-card-secondary);
    border-bottom: 1px solid var(--divider);
    position: sticky;
    top: 0;
    z-index: 5;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-radius: 3px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: left;
  }

  .column-header:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .column-header.active {
    color: var(--text-primary);
  }

  .column-header:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .sort-indicator {
    opacity: 0.7;
  }

  .file-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px 8px;
  }

  /* Clipboard banner */
  .clipboard-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-sm) var(--spacing-md);
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.08), rgba(0, 120, 212, 0.04));
    border-bottom: 1px solid rgba(0, 120, 212, 0.15);
    color: var(--accent);
    animation: slideDown 200ms cubic-bezier(0, 0, 0, 1);
  }

  .clipboard-banner.cut {
    background: linear-gradient(135deg, rgba(157, 93, 0, 0.08), rgba(157, 93, 0, 0.04));
    border-color: rgba(157, 93, 0, 0.15);
    color: var(--system-caution);
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .clipboard-content {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: var(--font-size-caption);
  }

  .clipboard-text {
    color: var(--text-primary);
  }

  .clipboard-hint {
    color: var(--text-tertiary);
    padding-left: var(--spacing-sm);
    border-left: 1px solid var(--divider);
    margin-left: var(--spacing-xs);
  }

  .clipboard-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .clipboard-clear:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  /* Toast notifications */
  .toast {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    margin: var(--spacing-sm) var(--spacing-sm) 0;
    background: var(--background-acrylic);
    backdrop-filter: blur(20px);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-md);
    font-size: var(--font-size-caption);
    box-shadow: var(--shadow-tooltip);
    animation: toastIn 200ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes toastIn {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .toast.error {
    background: linear-gradient(135deg, rgba(196, 43, 28, 0.1), rgba(196, 43, 28, 0.05));
    border-color: rgba(196, 43, 28, 0.2);
    color: var(--system-critical);
  }

  .toast.success {
    background: linear-gradient(135deg, rgba(15, 123, 15, 0.1), rgba(15, 123, 15, 0.05));
    border-color: rgba(15, 123, 15, 0.2);
    color: var(--system-success);
  }

  /* Status states */
  .status {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-md);
    padding: var(--spacing-xl) * 2;
    text-align: center;
    color: var(--text-secondary);
    font-size: var(--font-size-body);
    flex: 1;
  }

  .empty-state,
  .error-state {
    animation: fadeIn 300ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  .error-state {
    color: var(--system-critical);
  }

  .error-title {
    font-weight: 500;
    color: var(--text-primary);
  }

  .error-message {
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
    max-width: 300px;
  }

  /* Loading spinner */
  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 800ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* File row wrapper for staggered animation */
  .file-row-wrapper {
    animation: itemIn 150ms cubic-bezier(0, 0, 0, 1) backwards;
    animation-delay: calc(var(--index) * 15ms);
  }

  @keyframes itemIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
