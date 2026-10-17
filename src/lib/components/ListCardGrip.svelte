<!--
  A List card's bottom-edge resize grip (#1240, spec §10): a WAI movable
  separator snapped to whole rows. It is rendered inside the folder's own
  header treeitem, because a tree may own only groups and treeitems, and is
  positioned against the card's slot (List entries are not positioned), so it
  still sits on the card's bottom edge. The drag session, its clamp and the
  preview live in useListColumns, so a column that unmounts mid-drag (a
  sideways wheel) cannot strand them; this is only the control.
-->
<script lang="ts">
  interface Props {
    /** The card folder's name, for the accessible label. */
    name: string;
    /** Rows shown now (the preview while dragging). */
    rows: number;
    /** The largest height that keeps the card in its column. */
    max: number;
    dragging: boolean;
    onstart: (pointer: number, clientY: number) => void;
    /** Separator keys; true when the key was the grip's. */
    onkey: (key: string) => boolean;
  }
  let { name, rows, max, dragging, onstart, onkey }: Props = $props();

  function down(event: PointerEvent): void {
    if (event.button !== 0) return;
    // No text selection, no focus move and no row press or drag.
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -- WAI movable separator is an interactive range; the click only stays out of the row. -->
<div class="list-card-grip" role="separator" tabindex="0" aria-orientation="horizontal" draggable="false"
  aria-label={`Resize ${name}`} aria-valuemin={1} aria-valuemax={max} aria-valuenow={rows}
  class:dragging onpointerdown={down} onkeydown={key}><i></i></div>

<style>
  /* Positioned against the card's slot, whose bottom is the card's bottom edge. */
  .list-card-grip {
    position: absolute;
    bottom: -5px;
    left: calc(50% - 26px);
    width: 52px;
    height: 14px;
    display: grid;
    place-items: center;
    cursor: ns-resize;
    touch-action: none;
    z-index: 3;
  }
  .list-card-grip i { display: block; width: 38px; height: 4px; border-radius: 2px; background: var(--text-tertiary); opacity: 0.35; }
  .list-card-grip:hover i, .list-card-grip.dragging i { opacity: 0.7; }
  .list-card-grip:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; border-radius: 4px; }
</style>
