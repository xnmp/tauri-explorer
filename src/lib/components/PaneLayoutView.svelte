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
  const motion = usePaneCreationMotion({ root: () => canvas, layout: () => node, shown: () => shown });
</script>

<div class="pane-layout" bind:this={canvas}>
  {#each layout.panes as pane (pane.id)}
    {@const explorer = windowTabsManager.getExplorer(pane.id)}
    <!-- --pane-content-hold-x: domain/pane-motion PANE_CONTENT_HOLD_X (#1718). -->
    <div class="pane-frame" id={`pane-region-${pane.id}`} data-pane-motion={`pane:${pane.id}`} style={pane.style}
      style:--pane-content-hold-x={motion.heldWidth(pane.id)}>
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
      data-dragging={dividers.activeId === node.id || undefined}
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
      <div class="divider-handle" data-region="split-grip"></div>
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

  /* The divider draws the same line as ResizeHandle from the same tokens
     (#1925): a --resize-line hairline at rest, a --resize-active bar after
     --resize-hover-delay on hover or focus, at once while dragging. Its box
     stays the modelled --pane-divider-size (#1061); ::after widens the hit
     area to --resize-hit without changing layout. */
  .pane-divider {
    --w: var(--resize-line-width, 1px);
    --c: var(--resize-line, var(--layout-hairline, var(--divider)));
    position: relative;
    pointer-events: auto;
    box-sizing: border-box;
    touch-action: none;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    outline: none;
  }

  .pane-divider:is(:hover, :focus-visible), .pane-split.resizing > .pane-divider {
    --w: var(--resize-active-width, 3px);
    --c: var(--resize-active, var(--accent));
  }

  .pane-divider::before, .pane-divider::after {
    content: "";
    position: absolute;
  }

  .pane-divider::before {
    pointer-events: none;
    background: var(--c);
    transition: none;
  }

  .pane-divider:is(:hover, :focus-visible)::before {
    transition-property: width, height, left, top, background-color;
    transition-duration: 80ms;
    transition-delay: var(--resize-hover-delay, 250ms);
  }

  .pane-split.resizing > .pane-divider::before {
    transition: none;
  }

  .pane-split.row > .pane-divider {
    width: var(--pane-divider-size, 6px);
    cursor: col-resize;
  }

  .pane-split.column > .pane-divider {
    height: var(--pane-divider-size, 6px);
    cursor: row-resize;
  }

  /* Centred on the divider, rounded half a pixel down to the device grid. */
  .pane-split.row > .pane-divider::before {
    top: 0;
    bottom: 0;
    width: var(--w);
    left: calc(50% - var(--w) / 2 + 0.5px);
  }

  .pane-split.column > .pane-divider::before {
    left: 0;
    right: 0;
    height: var(--w);
    top: calc(50% - var(--w) / 2 + 0.5px);
  }

  .pane-split.row > .pane-divider::after {
    top: 0;
    bottom: 0;
    left: calc((var(--pane-divider-size, 6px) - max(var(--resize-hit, 10px), var(--pane-divider-size, 6px))) / 2);
    right: calc((var(--pane-divider-size, 6px) - max(var(--resize-hit, 10px), var(--pane-divider-size, 6px))) / 2);
  }

  .pane-split.column > .pane-divider::after {
    left: 0;
    right: 0;
    top: calc((var(--pane-divider-size, 6px) - max(var(--resize-hit, 10px), var(--pane-divider-size, 6px))) / 2);
    bottom: calc((var(--pane-divider-size, 6px) - max(var(--resize-hit, 10px), var(--pane-divider-size, 6px))) / 2);
  }

  /* The grip: the capsule a gutter layout shows instead of the line
     (Floating Islands, Soft Cards). Hidden in the hairline layouts. */
  .divider-handle {
    display: none;
    border-radius: 2px;
    background: var(--text-tertiary);
  }

  .pane-split.row > .pane-divider .divider-handle {
    width: 3px;
    height: 24px;
  }

  .pane-split.column > .pane-divider .divider-handle {
    width: 24px;
    height: 3px;
  }

  .pane-split.row.resizing > .pane-divider .divider-handle { height: 48px; }
  .pane-split.column.resizing > .pane-divider .divider-handle { width: 48px; }
</style>
