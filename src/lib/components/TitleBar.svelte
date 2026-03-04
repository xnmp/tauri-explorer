<!--
  Custom Title Bar - Windows 11 style (compact)
  Shows only when multiple tabs are open (tab bar + drag region).
  Window controls have moved to SharedToolbar.
  Issue: tauri-explorer-adtw, tauri-explorer-ikiq, tauri-explorer-ldfx, tauri-2e92
-->
<script lang="ts">
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
  import WindowTabBar from "./WindowTabBar.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";

  const showTabBar = $derived(windowTabsManager.tabs.length > 1);
  const showTitleBar = $derived(showTabBar);

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

{#if showTitleBar}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="titlebar" onmousedown={handleDragStart}>
  <!-- Window-level tab bar -->
  <WindowTabBar />

  <!-- Spacer for drag region -->
  <div class="spacer"></div>
</div>
{/if}

<style>
  .titlebar {
    display: flex;
    align-items: center;
    height: 38px;
    background: var(--background-card);
    user-select: none;
    flex-shrink: 0;
    position: relative;
    border-bottom: none;
    box-shadow: 0 1px 0 var(--surface-stroke);
  }

  /* Subtle gradient overlay for depth */
  .titlebar::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      var(--control-fill-tertiary) 0%,
      transparent 100%
    );
    opacity: 0.4;
    pointer-events: none;
  }

  .spacer {
    flex: 1;
    height: 100%;
  }
</style>
