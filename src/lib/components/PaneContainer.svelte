<!--
  PaneContainer component - Dual pane layout container
  Handles split view with resizable divider between panes.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs)
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import ExplorerPane from "./ExplorerPane.svelte";
  import PreviewPane from "./PreviewPane.svelte";

  // Get layout state from active window tab
  const dualPaneEnabled = $derived(windowTabsManager.dualPaneEnabled);
  const splitRatio = $derived(windowTabsManager.splitRatio);

  // Resize state
  let isResizing = $state(false);
  let containerRef = $state<HTMLElement | null>(null);

  function startResize(event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
  }

  function handleResize(event: MouseEvent) {
    if (!isResizing || !containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    windowTabsManager.setSplitRatio(ratio);
  }

  function endResize() {
    isResizing = false;
  }
</script>

<svelte:window onmousemove={handleResize} onmouseup={endResize} />

<div
  class="pane-container"
  class:dual-pane={dualPaneEnabled}
  class:resizing={isResizing}
  bind:this={containerRef}
  style={dualPaneEnabled ? `--split-ratio: ${splitRatio}` : ""}
>
  <div class="pane left-pane">
    <ExplorerPane paneId="left" />
  </div>

  {#if dualPaneEnabled}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pane-divider"
      onmousedown={startResize}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
    >
      <div class="divider-handle"></div>
    </div>

    <div class="pane right-pane">
      <ExplorerPane paneId="right" />
    </div>
  {/if}

  {#if settingsStore.showPreviewPane}
    <PreviewPane />
  {/if}
</div>

<style>
  .pane-container {
    display: flex;
    flex: 1;
    overflow: hidden;
    gap: 0;
  }

  .pane-container.resizing {
    cursor: col-resize;
    user-select: none;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  /* Single pane mode - full width */
  .pane-container:not(.dual-pane) .left-pane {
    flex: 1;
  }

  /* Dual pane mode - split based on ratio */
  .pane-container.dual-pane .left-pane {
    flex: var(--split-ratio, 0.5);
    min-width: 200px;
  }

  .pane-container.dual-pane .right-pane {
    flex: calc(1 - var(--split-ratio, 0.5));
    min-width: 200px;
  }

  .pane-divider {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 6px;
    background: transparent;
    border-left: 1px solid var(--divider);
    border-right: 1px solid var(--divider);
    cursor: col-resize;
    flex-shrink: 0;
    transition:
      background var(--transition-fast),
      border-color var(--transition-fast);
  }

  .pane-divider:hover {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-color: var(--accent);
  }

  .pane-container.resizing .pane-divider {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border-color: var(--accent);
  }

  .divider-handle {
    width: 4px;
    height: 32px;
    background: var(--text-tertiary);
    border-radius: 2px;
    opacity: 0.5;
    transition: opacity var(--transition-fast);
  }

  .pane-divider:hover .divider-handle,
  .pane-container.resizing .divider-handle {
    opacity: 1;
    background: var(--text-on-accent);
  }

  /* Vibrancy: main content island — top highlight drawn via ::before with tab gap */
  :global([data-vibrancy]) .pane-container {
    border-radius: var(--vibrancy-island-radius);
    background: var(--vibrancy-island-bg);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-top: none;
    box-shadow:
      inset 0 -0.5px 0 rgba(0, 0, 0, 0.15),
      0 2px 8px rgba(0, 0, 0, 0.12),
      0 8px 24px rgba(0, 0, 0, 0.08);
    position: relative;
  }

  :global([data-vibrancy]) .pane-container::before {
    content: "";
    position: absolute;
    top: 0;
    left: var(--vibrancy-island-radius);
    right: var(--vibrancy-island-radius);
    height: 1px;
    background: rgba(255, 255, 255, 0.15);
    mask-image: linear-gradient(
      to right,
      white 0%,
      white var(--tab-gap-left, 30%),
      transparent var(--tab-gap-left, 30%),
      transparent var(--tab-gap-right, 60%),
      white var(--tab-gap-right, 60%),
      white 100%
    );
    -webkit-mask-image: linear-gradient(
      to right,
      white 0%,
      white var(--tab-gap-left, 30%),
      transparent var(--tab-gap-left, 30%),
      transparent var(--tab-gap-right, 60%),
      white var(--tab-gap-right, 60%),
      white 100%
    );
    pointer-events: none;
  }
</style>
