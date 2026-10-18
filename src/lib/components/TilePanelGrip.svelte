<!--
  A Tiles panel's resize grip (#1241, spec §9.2): a WAI movable separator on
  the panel edge farthest from its parent. A grid may own only rows, so it sits
  in its own row and cell. The drag session, its clamp and the band preview
  live in useTilePanels, so a band that unmounts mid-drag (scrolled out)
  cannot strand them; this is only the control.
-->
<script lang="ts">
  import type { BandSide } from "$lib/domain/tile-panels";

  interface Props {
    /** The panel folder's name, for the accessible label. */
    name: string;
    side: BandSide;
    /** The band's height now (the preview while dragging). */
    height: number;
    min: number;
    max: number;
    /** A tile row's height, for the value text. */
    rowHeight: number;
    dragging: boolean;
    onstart: (pointer: number, clientY: number) => void;
    /** Separator keys; true when the key was the grip's. */
    onkey: (key: string) => boolean;
  }
  let { name, side, height, min, max, rowHeight, dragging, onstart, onkey }: Props = $props();

  function down(event: PointerEvent): void {
    if (event.button !== 0) return;
    // No text selection, no focus move and no tile press or drag.
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    onstart(event.pointerId, event.clientY);
  }
  function key(event: KeyboardEvent): void {
    if (!onkey(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
  }
</script>

<div class="tile-panel-grip-row" class:above={side === "above"} role="row">
  <div class="tile-panel-grip-cell" role="gridcell">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is an interactive range. -->
    <div class="tile-panel-grip" role="separator" tabindex="0" aria-orientation="horizontal" draggable="false"
      aria-label={`Resize ${name}`} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(height)}
      aria-valuetext={`${Math.max(1, Math.round(height / rowHeight))} rows`}
      class:dragging onpointerdown={down} onkeydown={key}><i></i></div>
  </div>
</div>

<style>
  /* A zero-height row on the far edge; the pill straddles it. */
  .tile-panel-grip-row {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 0;
    z-index: 3;
  }
  .tile-panel-grip-row.above { top: 0; bottom: auto; }
  .tile-panel-grip {
    position: absolute;
    top: -7px;
    left: calc(50% - 26px);
    width: 52px;
    height: 14px;
    display: grid;
    place-items: center;
    cursor: ns-resize;
    touch-action: none;
  }
  .tile-panel-grip i { display: block; width: 38px; height: 4px; border-radius: 2px; background: var(--text-tertiary); opacity: 0.35; }
  .tile-panel-grip:hover i, .tile-panel-grip.dragging i { opacity: 0.7; }
  .tile-panel-grip:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; border-radius: 4px; }
</style>
