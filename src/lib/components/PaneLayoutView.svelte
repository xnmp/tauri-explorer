<!--
  PaneLayoutView — recursive renderer for a tab's pane layout tree (#228).
  A leaf renders an ExplorerPane; a split renders its two children side by
  side (row) or stacked (column) with a resizable divider between them.
  Each split node owns its own divider drag; the ratio lives in the tree
  (windowTabsManager.setSplitRatio).
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { someLeaf, type PaneNode } from "$lib/domain/pane-layout";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { createPaneResize } from "$lib/state/pane-resize";
  import ExplorerPane from "./ExplorerPane.svelte";
  import PaneLayoutView from "./PaneLayoutView.svelte";

  const { node }: { node: PaneNode } = $props();

  const materialized = $derived(someLeaf(node, windowTabsManager.isPaneReady));

  // Resize state (only used when node is a split)
  let isResizing = $state(false);
  let containerRef = $state<HTMLElement | null>(null);
  let capturedPointer: number | undefined;
  let releasePointer: (() => void) | undefined;
  const resize = createPaneResize({
    schedule: (callback) => {
      const frame = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frame);
    },
    publishActive: (active) => {
      isResizing = active;
      if (!active) {
        const release = releasePointer;
        capturedPointer = undefined;
        releasePointer = undefined;
        release?.();
      }
    },
  });
  onDestroy(resize.cancel);

  function startResize(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || node.type !== "split" || !containerRef) return;
    event.preventDefault();
    // Capture geometry once: pointer moves never force layout or read live props.
    const rect = containerRef.getBoundingClientRect();
    resize.start({
      direction: node.direction,
      start: node.direction === "row" ? rect.left : rect.top,
      extent: node.direction === "row" ? rect.width : rect.height,
      commit: windowTabsManager.beginSplitResize(node.id),
    });
    if (isResizing) {
      const divider = event.currentTarget as HTMLElement;
      divider.setPointerCapture(event.pointerId);
      capturedPointer = event.pointerId;
      releasePointer = () => {
        if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      };
    }
  }

  // rAF-coalesced: mousemove can fire far above frame rate on high-poll-rate
  // mice; applying every event triggers a full pane re-layout each time.
  function handleResize(event: PointerEvent) {
    if (event.pointerId !== capturedPointer) return;
    if ((event.buttons & 1) === 0) { resize.cancel(); return; }
    resize.move(event.clientX, event.clientY);
  }

  function finishResize(event: PointerEvent) {
    if (event.pointerId === capturedPointer) resize.finish();
  }

  function cancelResize(event: PointerEvent) {
    if (event.pointerId === capturedPointer) resize.cancel();
  }
</script>

<svelte:window onblur={resize.cancel} />

{#if !materialized}
  <div class="pane-restoring" aria-busy="true">Restoring panes…</div>
{:else if node.type === "leaf"}
  {@const explorer = windowTabsManager.getExplorer(node.id)}
  {#if explorer}
    {#key explorer}
      <ExplorerPane paneId={node.id} {explorer} />
    {/key}
  {:else}
    <div role="alert">Unable to load this pane.</div>
  {/if}
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
      onpointerdown={startResize}
      onpointermove={handleResize}
      onpointerup={finishResize}
      onpointercancel={cancelResize}
      onlostpointercapture={cancelResize}
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
  .pane-restoring {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 12px;
  }

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
    touch-action: none;
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
    border-left: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    border-right: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    cursor: col-resize;
  }

  .pane-split.column > .pane-divider {
    height: 6px;
    border-top: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    border-bottom: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    cursor: row-resize;
  }

  /* Island mode: panes are separate islands (see ExplorerPane), so the
     divider is a clear gap matching the inter-island gap, not a drawn line. */
  :global([data-vibrancy]) .pane-split.row > .pane-divider {
    width: 8px;
    border-color: transparent;
  }

  :global([data-vibrancy]) .pane-split.column > .pane-divider {
    height: 8px;
    border-color: transparent;
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
