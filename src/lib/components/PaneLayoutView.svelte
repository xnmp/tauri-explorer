<!--
  PaneLayoutView — recursive renderer for a tab's pane layout tree (#228).
  A leaf renders an ExplorerPane; a split renders its two children side by
  side (row) or stacked (column) with a resizable divider between them.
  Each split node owns its own divider drag; the ratio lives in the tree
  (windowTabsManager.setSplitRatio).
-->
<script lang="ts">
  import type { PaneNode } from "$lib/domain/pane-layout";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import ExplorerPane from "./ExplorerPane.svelte";
  import PaneLayoutView from "./PaneLayoutView.svelte";

  const { node }: { node: PaneNode } = $props();

  // Resize state (only used when node is a split)
  let isResizing = $state(false);
  let containerRef = $state<HTMLElement | null>(null);
  // Container rect is stable for the duration of a drag; cache it so
  // mousemove never forces a layout read.
  let containerRect: DOMRect | null = null;
  let pendingClient: number | null = null;
  let moveRafId = 0;

  function startResize(event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
    containerRect = containerRef?.getBoundingClientRect() ?? null;
  }

  function applyPendingResize() {
    if (pendingClient === null || !containerRect || node.type !== "split") return;
    const ratio =
      node.direction === "row"
        ? (pendingClient - containerRect.left) / containerRect.width
        : (pendingClient - containerRect.top) / containerRect.height;
    windowTabsManager.setSplitRatio(node.id, ratio);
    pendingClient = null;
  }

  // rAF-coalesced: mousemove can fire far above frame rate on high-poll-rate
  // mice; applying every event triggers a full pane re-layout each time.
  function handleResize(event: MouseEvent) {
    if (!isResizing || node.type !== "split") return;
    pendingClient = node.direction === "row" ? event.clientX : event.clientY;
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

{#if node.type === "leaf"}
  <ExplorerPane paneId={node.id} />
{:else}
  <div
    class="pane-split {node.direction}"
    class:resizing={isResizing}
    bind:this={containerRef}
    style="--split-ratio: {node.ratio}"
  >
    <div class="split-child first">
      <PaneLayoutView node={node.first} />
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
    <div
      class="pane-divider"
      onmousedown={startResize}
      role="separator"
      aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
      aria-label="Resize panes"
    >
      <div class="divider-handle"></div>
    </div>

    <div class="split-child second">
      <PaneLayoutView node={node.second} />
    </div>
  </div>
{/if}

<style>
  .pane-split {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .pane-split.column {
    flex-direction: column;
  }

  .pane-split.row.resizing {
    cursor: col-resize;
    user-select: none;
  }

  .pane-split.column.resizing {
    cursor: row-resize;
    user-select: none;
  }

  .split-child {
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .split-child.first {
    flex: var(--split-ratio, 0.5);
  }

  .split-child.second {
    flex: calc(1 - var(--split-ratio, 0.5));
  }

  .pane-split.row > .split-child {
    min-width: 120px;
  }

  .pane-split.column > .split-child {
    min-height: 80px;
  }

  .pane-divider {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: transparent;
    transition:
      background var(--transition-fast),
      border-color var(--transition-fast);
  }

  .pane-split.row > .pane-divider {
    width: 6px;
    border-left: 1px solid var(--divider);
    border-right: 1px solid var(--divider);
    cursor: col-resize;
  }

  .pane-split.column > .pane-divider {
    height: 6px;
    border-top: 1px solid var(--divider);
    border-bottom: 1px solid var(--divider);
    cursor: row-resize;
  }

  .pane-divider:hover {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-color: var(--accent);
  }

  .pane-split.resizing > .pane-divider {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border-color: var(--accent);
  }

  .divider-handle {
    background: var(--text-tertiary);
    border-radius: 2px;
    opacity: 0.5;
    transition: opacity var(--transition-fast);
  }

  .pane-split.row > .pane-divider .divider-handle {
    width: 4px;
    height: 32px;
  }

  .pane-split.column > .pane-divider .divider-handle {
    width: 32px;
    height: 4px;
  }

  .pane-divider:hover .divider-handle,
  .pane-split.resizing > .pane-divider .divider-handle {
    opacity: 1;
    background: var(--text-on-accent);
  }
</style>
