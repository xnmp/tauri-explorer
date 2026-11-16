<!--
  PaneLayoutView — flat, identity-stable renderer of a split tree (#1703).
  The CSS-sized canvas publishes presentation bounds before paint on resize.
  The split tree still owns layout; pane DOM is keyed independently of ancestry.
-->
<script lang="ts">
  import type { PaneNode } from "$lib/domain/pane-layout";
  import { panePresentation } from "$lib/domain/pane-presentation";
  import { preferredSplitRatio, type PaneGeometry, type PaneSize } from "$lib/domain/pane-viewport";
  import type { PaneDividers } from "$lib/composables/use-pane-dividers.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import ExplorerPane from "./ExplorerPane.svelte";
  import { usePaneCreationMotion } from "$lib/composables/use-pane-creation-motion.svelte";
  import { usePaneCanvasSize } from "$lib/composables/use-pane-canvas-size.svelte";
  import { layoutStore } from "$lib/state/layout.svelte";

  const { node, geometry, minima, dividers, shown }: {
    node: PaneNode; geometry?: PaneGeometry; minima?: ReadonlyMap<string, PaneSize>; dividers: PaneDividers; shown: boolean;
  } = $props();
  let canvas = $state<HTMLElement>();
  const size = usePaneCanvasSize(() => canvas);
  const layout = $derived(panePresentation(node, size.current, layoutStore.paneDividerSize, minima, windowTabsManager.isPaneReady));
  usePaneCreationMotion({ root: () => canvas, layout: () => node, shown: () => shown });
</script>

<div class="pane-layout" bind:this={canvas}>
  {#each layout.panes as pane (pane.id)}
    {@const explorer = windowTabsManager.getExplorer(pane.id)}
    <div class="pane-frame" id={`pane-region-${pane.id}`} data-pane-motion={`pane:${pane.id}`} style={pane.style}>
      {#if explorer}
        {#key explorer}
          <ExplorerPane paneId={pane.id} {explorer} />
        {/key}
      {:else}
        <div class="pane-restoring" aria-busy="true">Restoring panes…</div>
      {/if}
    </div>
  {/each}
  {#each layout.placeholders as placeholder (placeholder.id)}
    <div class="pane-frame pane-restoring" style={placeholder.style} aria-busy="true">Restoring panes…</div>
  {/each}
  {#each layout.splits as item (item.node.id)}
    {@const node = item.node}
    {@const split = geometry?.splits.get(node.id)}
  <div
    class="pane-split {node.direction}"
    class:resizing={dividers.activeId === node.id}
    style="{item.style};--split-ratio: {preferredSplitRatio(node.ratio)}"
  >
    <div class="split-child first" style:--split-min={`${item.firstMinimum}px`}></div>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is a focusable range control with arrow/Home/End input. -->
    <div
      class="pane-divider"
      data-region="split-divider"
      data-pane-motion={`split:${node.id}`}
      onpointerdown={(event) => dividers.start(event, node)}
      onpointermove={dividers.move}
      onpointerup={dividers.finish}
      onpointercancel={dividers.cancelPointer}
      onlostpointercapture={dividers.cancelPointer}
      onkeydown={(event) => dividers.key(event, node)}
      role="separator"
      tabindex="0"
      aria-controls={item.controls}
      aria-valuemin={(split?.min ?? 0.1) * 100}
      aria-valuemax={(split?.max ?? 0.9) * 100}
      aria-valuenow={(split?.ratio ?? node.ratio) * 100}
      aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
      aria-label="Resize panes"
    >
      <div class="divider-handle"></div>
    </div>

    <div class="split-child second" style:--split-min={`${item.secondMinimum}px`}></div>
  </div>
  {/each}
</div>

<style>
  .pane-layout {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    /* Stale absolute bounds must not create workspace gutters before the
       synchronous size delivery settles. Genuine overflow is the parent
       pane-tree's minimum size; clip adds no inner scroll container. */
    overflow: clip;
  }

  .pane-frame {
    position: absolute;
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

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
    position: absolute;
    pointer-events: none;
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

  .pane-split.row > .split-child {
    min-width: var(--split-min, 0);
  }

  .pane-split.column > .split-child {
    min-height: var(--split-min, 0);
  }

  .split-child.first {
    flex: var(--split-ratio, 0.5);
  }

  .split-child.second {
    flex: calc(1 - var(--split-ratio, 0.5));
  }

  .pane-divider {
    pointer-events: auto;
    /* Occupy exactly the modelled divider extent, borders included, so the
       children's minima and the divider always fit the canvas minimum. */
    box-sizing: border-box;
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

  .pane-divider:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
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
