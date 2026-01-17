<!--
  Custom Title Bar - Windows 11 style (compact)
  Issue: tauri-explorer-adtw, tauri-explorer-ikiq, tauri-explorer-ldfx
-->
<script lang="ts">
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import WindowTabBar from "./WindowTabBar.svelte";

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
    // Only drag on left click
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    // Don't drag when clicking on interactive elements (buttons, tabs)
    if (target.closest('button') || target.closest('.tab-area')) return;

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
  <!-- Window-level tab bar -->
  <WindowTabBar />

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
    height: 32px;
    background: var(--background-card);
    user-select: none;
    flex-shrink: 0;
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
    width: 44px;
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
