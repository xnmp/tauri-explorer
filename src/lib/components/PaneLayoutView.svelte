<!--
  PaneLayoutView — recursive renderer for a tab's pane layout tree (#228).
  A leaf renders an ExplorerPane; a split renders its two children side by
  side (row) or stacked (column) with a resizable divider between them.
  The container owns divider input; this renderer consumes shared measured
  geometry while saved ratios remain in the window-tab tree.
-->
<script lang="ts">
  import { someLeaf, type PaneNode } from "$lib/domain/pane-layout";
  import type { PaneGeometry } from "$lib/domain/pane-viewport";
  import type { PaneDividers } from "$lib/composables/use-pane-dividers.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import ExplorerPane from "./ExplorerPane.svelte";
  import PaneLayoutView from "./PaneLayoutView.svelte";

  const { node, geometry, dividers }: { node: PaneNode; geometry?: PaneGeometry; dividers: PaneDividers } = $props();
  const materialized = $derived(someLeaf(node, windowTabsManager.isPaneReady));
  const split = $derived(geometry?.splits.get(node.id));
</script>

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
    class:resizing={dividers.activeId === node.id}
    style="--split-ratio: {split?.ratio ?? node.ratio}"
  >
    <div class="split-child first" id={`pane-region-${node.id}`}>
      <PaneLayoutView node={node.first} {geometry} {dividers} />
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is a focusable range control with arrow/Home/End input. -->
    <div
      class="pane-divider"
      onpointerdown={(event) => { if (node.type === "split") dividers.start(event, node); }}
      onpointermove={dividers.move}
      onpointerup={dividers.finish}
      onpointercancel={dividers.cancelPointer}
      onlostpointercapture={dividers.cancelPointer}
      onkeydown={(event) => { if (node.type === "split") dividers.key(event, node); }}
      role="separator"
      tabindex="0"
      aria-controls={`pane-region-${node.id}`}
      aria-valuemin={(split?.min ?? 0.1) * 100}
      aria-valuemax={(split?.max ?? 0.9) * 100}
      aria-valuenow={(split?.ratio ?? node.ratio) * 100}
      aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
      aria-label="Resize panes"
    >
      <div class="divider-handle"></div>
    </div>

    <div class="split-child second">
      <PaneLayoutView node={node.second} {geometry} {dividers} />
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
    width: var(--pane-divider-size, 6px);
    border-left: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    border-right: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    cursor: col-resize;
  }

  .pane-split.column > .pane-divider {
    height: var(--pane-divider-size, 6px);
    border-top: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    border-bottom: 1px solid var(--pane-divider, color-mix(in srgb, var(--text-primary) 15%, transparent));
    cursor: row-resize;
  }

  /* Island mode: panes are separate islands (see ExplorerPane), so the
     divider is a clear gap matching the inter-island gap, not a drawn line. */
  :global([data-vibrancy]) .pane-split.row > .pane-divider {
    border-color: transparent;
  }

  :global([data-vibrancy]) .pane-split.column > .pane-divider {
    border-color: transparent;
  }

  .pane-divider:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
