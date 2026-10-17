<!--
  A List card's bottom-edge resize grip (#1240, spec §10): a WAI movable
  separator snapped to whole rows. It is rendered inside the folder's own
  header treeitem, because a tree may own only groups and treeitems, and is
  positioned against the card's slot (List entries are not positioned), so it
  still sits on the card's bottom edge. Policies are pure (list-cards.ts); the
  preview lives in useListColumns.
-->
<script lang="ts">
  import type { ListCardSpec } from "$lib/domain/list-column-flow";
  import { cardMaxRows, gripKeyRows, gripRows } from "$lib/domain/list-cards";
  import { rectDimToCSS } from "$lib/domain/zoom";

  interface Props {
    /** The card folder's name, for the accessible label. */
    name: string;
    card: ListCardSpec;
    /** Rows per column (the grip's cap). */
    R: number;
    /** Rows shown while the grip is dragged, else null. */
    previewRows: number | null;
    onpreview: (rows: number | null) => void;
    oncommit: (rows: number) => void;
  }
  let { name, card, R, previewRows, onpreview, oncommit }: Props = $props();

  const content = $derived(card.end - card.start);
  const visible = $derived(previewRows ?? card.visibleRows);
  const maxRows = $derived(Math.max(1, Math.min(content, cardMaxRows(R))));

  // Pointer travel snaps to whole rows; only this card previews until release.
  let drag: { pointer: number; y: number; rows: number } | null = null;
  function down(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag = { pointer: event.pointerId, y: event.clientY, rows: visible };
  }
  const dragRows = (event: PointerEvent) => gripRows(drag!.rows, rectDimToCSS(event.clientY - drag!.y), content, R);
  function move(event: PointerEvent): void {
    if (drag?.pointer === event.pointerId) onpreview(dragRows(event));
  }
  function up(event: PointerEvent): void {
    if (drag?.pointer !== event.pointerId) return;
    const next = dragRows(event);
    drag = null;
    oncommit(next);
  }
  function cancel(): void {
    if (!drag) return;
    drag = null;
    onpreview(null);
  }
  function key(event: KeyboardEvent): void {
    const next = gripKeyRows(event.key, card.visibleRows, content, R);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== card.visibleRows) oncommit(next);
  }
</script>

{#if content > 0}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -- WAI movable separator is an interactive range; the click only stays out of the row. -->
  <div class="list-card-grip" role="separator" tabindex="0" aria-orientation="horizontal" draggable="false"
    aria-label={`Resize ${name}`} aria-valuemin={1} aria-valuemax={maxRows} aria-valuenow={visible}
    class:dragging={previewRows !== null}
    onpointerdown={down} onpointermove={move} onpointerup={up}
    onpointercancel={cancel} onlostpointercapture={cancel}
    onkeydown={key}><i></i></div>
{/if}

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
