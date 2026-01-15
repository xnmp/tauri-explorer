<!--
  Custom Title Bar - Windows 11 style
  Issue: tauri-explorer-adtw
-->
<script lang="ts">
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { explorer } from "$lib/state/explorer.svelte";

  // Check if running in Tauri environment
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  let appWindow: Window | null = null;
  try {
    if (isTauri) {
      appWindow = getCurrentWindow();
    }
  } catch {
    // Running in browser without Tauri runtime
  }
  let isMaximized = $state(false);

  // Get current folder name for the tab
  const folderName = $derived(() => {
    const path = explorer.state.currentPath;
    if (!path) return "Explorer";
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] || "Explorer";
  });

  onMount(() => {
    if (!appWindow) return;

    let unlisten: (() => void) | undefined;

    (async () => {
      isMaximized = await appWindow.isMaximized();
      unlisten = await appWindow.onResized(async () => {
        isMaximized = await appWindow!.isMaximized();
      });
    })();

    return () => unlisten?.();
  });

  async function handleMinimize() {
    await appWindow?.minimize();
  }

  async function handleMaximize() {
    await appWindow?.toggleMaximize();
  }

  async function handleClose() {
    await appWindow?.close();
  }

  // Handle window dragging manually for better compatibility
  async function handleDragStart(event: MouseEvent) {
    // Only drag on left click and not on buttons
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;

    // Double-click to maximize/restore
    if (event.detail === 2) {
      await appWindow?.toggleMaximize();
      return;
    }

    // Start dragging
    await appWindow?.startDragging();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="titlebar" onmousedown={handleDragStart}>
  <!-- Tab area -->
  <div class="tab-area">
    <div class="tab active">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="tab-icon">
        <path d="M2 3.5C2 2.67 2.67 2 3.5 2H6.17L8 3.83H12.5C13.33 3.83 14 4.5 14 5.33V12.5C14 13.33 13.33 14 12.5 14H3.5C2.67 14 2 13.33 2 12.5V3.5Z" fill="#FFB900"/>
      </svg>
      <span class="tab-title">{folderName()}</span>
      <button class="tab-close" onclick={(e) => e.stopPropagation()} aria-label="Close tab">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <button class="new-tab-btn" aria-label="New tab">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path d="M6 2V10M2 6H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  <!-- Spacer for drag region -->
  <div class="spacer"></div>

  <!-- Window controls -->
  <div class="window-controls">
    <button
      class="control-btn"
      onclick={handleMinimize}
      title="Minimize"
      aria-label="Minimize"
    >
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M0 5H10" stroke="currentColor" stroke-width="1"/>
      </svg>
    </button>
    <button
      class="control-btn"
      onclick={handleMaximize}
      title={isMaximized ? "Restore" : "Maximize"}
      aria-label={isMaximized ? "Restore" : "Maximize"}
    >
      {#if isMaximized}
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="2" y="2" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none"/>
          <path d="M2 2V1H9V8H8" stroke="currentColor" stroke-width="1" fill="none"/>
        </svg>
      {:else}
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1" y="1" width="8" height="8" stroke="currentColor" stroke-width="1" fill="none"/>
        </svg>
      {/if}
    </button>
    <button
      class="control-btn close"
      onclick={handleClose}
      title="Close"
      aria-label="Close"
    >
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
      </svg>
    </button>
  </div>
</div>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    height: 36px;
    background: var(--background-card);
    user-select: none;
    flex-shrink: 0;
  }

  .tab-area {
    display: flex;
    align-items: center;
    height: 100%;
    padding-left: 8px;
    gap: 2px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 8px 0 10px;
    background: var(--background-card-secondary);
    border-radius: 6px 6px 0 0;
    font-size: 12px;
    color: var(--text-primary);
  }

  .tab-icon {
    flex-shrink: 0;
  }

  .tab-title {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition: all var(--transition-fast);
  }

  .tab:hover .tab-close {
    opacity: 1;
  }

  .tab-close:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .new-tab-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .new-tab-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .spacer {
    flex: 1;
    height: 100%;
  }

  .window-controls {
    display: flex;
    height: 100%;
  }

  .control-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 100%;
    background: transparent;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .control-btn:hover {
    background: var(--subtle-fill-secondary);
  }

  .control-btn.close:hover {
    background: #c42b1c;
    color: white;
  }

  .control-btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }
</style>
