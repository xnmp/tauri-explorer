<!--
  PaneContainer component - Dual pane layout container
  Handles split view with resizable divider between panes.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs)
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import ExplorerPane from "./ExplorerPane.svelte";
  import PaneTabBar from "./PaneTabBar.svelte";

  // Window-level layout state
  const dualPaneEnabled = $derived(windowTabsManager.dualPaneEnabled);
  const splitRatio = $derived(windowTabsManager.splitRatio);

  // Resize state
  let isResizing = $state(false);
  let containerRef = $state<HTMLElement | null>(null);
  // Container rect is stable for the duration of a drag; cache it so
  // mousemove never forces a layout read.
  let containerRect: DOMRect | null = null;
  let pendingClientX: number | null = null;
  let moveRafId = 0;

  function startResize(event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
    containerRect = containerRef?.getBoundingClientRect() ?? null;
  }

  function applyPendingResize() {
    if (pendingClientX === null || !containerRect) return;
    const ratio = (pendingClientX - containerRect.left) / containerRect.width;
    windowTabsManager.setSplitRatio(ratio);
    pendingClientX = null;
  }

  // rAF-coalesced: mousemove can fire far above frame rate on high-poll-rate
  // mice; applying every event triggers a full pane re-layout each time.
  function handleResize(event: MouseEvent) {
    if (!isResizing) return;
    pendingClientX = event.clientX;
    if (moveRafId) return;
    moveRafId = requestAnimationFrame(() => {
      moveRafId = 0;
      applyPendingResize();
    });
  }

  function endResize() {
    if (!isResizing) return;
    if (moveRafId) {
      cancelAnimationFrame(moveRafId);
      moveRafId = 0;
    }
    applyPendingResize();
    isResizing = false;
    containerRect = null;
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
    <PaneTabBar paneId="left" />
    <ExplorerPane paneId="left" />
  </div>

  {#if dualPaneEnabled}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
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
      <PaneTabBar paneId="right" />
      <ExplorerPane paneId="right" />
    </div>
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
    border: 1px solid var(--vibrancy-island-stroke);
    border-top: none;
    box-shadow: var(--vibrancy-island-glow);
    backdrop-filter: blur(12px) brightness(1.08) saturate(1.2);
    -webkit-backdrop-filter: blur(12px) brightness(1.08) saturate(1.2);
    position: relative;
  }

  :global([data-vibrancy]) .pane-container::before {
    content: "";
    position: absolute;
    top: 0;
    left: var(--vibrancy-island-radius);
    right: var(--vibrancy-island-radius);
    height: 1px;
    background: var(--vibrancy-island-stroke);
    /* Tabs live inside the panes now, so the top highlight line is
       continuous (0% gap unless something re-introduces the vars). */
    mask-image: linear-gradient(
      to right,
      white 0%,
      white var(--tab-gap-left, 0%),
      transparent var(--tab-gap-left, 0%),
      transparent var(--tab-gap-right, 0%),
      white var(--tab-gap-right, 0%),
      white 100%
    );
    -webkit-mask-image: linear-gradient(
      to right,
      white 0%,
      white var(--tab-gap-left, 0%),
      transparent var(--tab-gap-left, 0%),
      transparent var(--tab-gap-right, 0%),
      white var(--tab-gap-right, 0%),
      white 100%
    );
    pointer-events: none;
  }
</style>
