<!--
  A Tiles panel's resize grip (#1241, spec §9.2): a WAI movable separator on
  the panel edge farthest from its parent. Dragging previews the whole band's
  height; release sets the preferred height of every band member. A grid may
  own only rows, so it sits in its own row and cell. Policies are pure
  (tile-panels.ts); the preview lives in useTilePanels.
-->
<script lang="ts">
  import { clampPreferredHeight, gripKeyHeight, type BandSide, type MiniTileLayout, type PanelHeightBounds } from "$lib/domain/tile-panels";
  import { rectDimToCSS } from "$lib/domain/zoom";

  interface Props {
    /** The panel folder's name, for the accessible label. */
    name: string;
    side: BandSide;
    /** The band's current height and the tallest member's content. */
    height: number;
    maxContent: number;
    mini: MiniTileLayout;
    bounds: PanelHeightBounds;
    dragging: boolean;
    onstart: () => void;
    onpreview: (height: number) => void;
    /** null cancels the drag. */
    onend: (height: number | null) => void;
  }
  let { name, side, height, maxContent, mini, bounds, dragging, onstart, onpreview, onend }: Props = $props();

  const max = $derived(Math.max(bounds.min, Math.min(bounds.max, maxContent)));
  // The far edge grows away from the parent: down below it, up above it.
  const direction = $derived(side === "above" ? -1 : 1);

  let drag: { pointer: number; y: number; height: number } | null = null;
  function down(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag = { pointer: event.pointerId, y: event.clientY, height };
    onstart();
  }
  const dragHeight = (event: PointerEvent) =>
    clampPreferredHeight(drag!.height + direction * rectDimToCSS(event.clientY - drag!.y), maxContent, bounds);
  function move(event: PointerEvent): void {
    if (drag?.pointer === event.pointerId) onpreview(dragHeight(event));
  }
  function up(event: PointerEvent): void {
    if (drag?.pointer !== event.pointerId) return;
    const next = dragHeight(event);
    drag = null;
    onend(next);
  }
  function cancel(): void {
    if (!drag) return;
    drag = null;
    onend(null);
  }
  function key(event: KeyboardEvent): void {
    const next = gripKeyHeight(event.key, side, height, maxContent, mini, bounds);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next === Math.round(height)) return;
    onstart();
    onend(next);
  }
</script>

<div class="tile-panel-grip-row" class:above={side === "above"} role="row">
  <div class="tile-panel-grip-cell" role="gridcell">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is an interactive range. -->
    <div class="tile-panel-grip" role="separator" tabindex="0" aria-orientation="horizontal" draggable="false"
      aria-label={`Resize ${name}`} aria-valuemin={bounds.min} aria-valuemax={max} aria-valuenow={Math.round(height)}
      aria-valuetext={`${Math.max(1, Math.round(height / mini.rowHeight))} rows`}
      class:dragging
      onpointerdown={down} onpointermove={move} onpointerup={up}
      onpointercancel={cancel} onlostpointercapture={cancel}
      onkeydown={key}><i></i></div>
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
