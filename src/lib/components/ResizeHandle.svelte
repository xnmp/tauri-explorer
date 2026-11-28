<!--
  ResizeHandle - the one panel resize handle (#1925): sidebar, SCM, preview,
  terminal and plugin inspector. Split dividers (PaneLayoutView) draw the same
  line from the same tokens.

  The hit area is an absolutely positioned strip `--resize-hit` across,
  reaching `--resize-outward` (3px) beyond the panel edge, or inside it with
  `inset` for a panel that clips its overflow, so it never changes layout. The drawn line is its ::before:
  a `--resize-line-width` hairline on the edge's inner pixel at rest, growing
  to a `--resize-active-width` accent bar after `--resize-hover-delay` on
  hover or keyboard focus, and at once while dragging. Layouts restyle it
  through `[data-region="resize-handle"]` (docs/layout-themes.md).

  A counter-zoomed host (the terminal, #419) sets `--resize-scale` to the app
  zoom so the handle keeps the app's dimensions at net zoom 1.
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ResizeController } from "$lib/composables/use-resize-owner.svelte";
  import { resizeOrientation, type ResizeEdge } from "$lib/domain/resize-edge";
  let { resize, label, controls, edge, inset = false }: {
    resize: ResizeController; label: string; controls: string; edge: ResizeEdge; inset?: boolean;
  } = $props();
  onDestroy(untrack(() => resize.retire));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is an interactive range. -->
<div class="resize-handle" data-region="resize-handle" data-edge={edge} data-inset={inset || undefined}
  data-dragging={resize.isResizing || undefined}
  role="separator" tabindex="0" aria-orientation={resizeOrientation(edge)} aria-label={label}
  aria-controls={controls} aria-valuemin={resize.min} aria-valuemax={resize.max}
  aria-valuenow={resize.value} aria-valuetext={`${Math.round(resize.value)} pixels`}
  onpointerdown={resize.startResize} onpointermove={resize.move} onpointerup={resize.finish}
  onpointercancel={resize.cancelPointer} onlostpointercapture={resize.cancelPointer}
  onkeydown={resize.keydown}></div>

<style>
  .resize-handle {
    --s: var(--resize-scale, 1);
    --hit: calc(var(--resize-hit, 10px) * var(--s));
    /* How far the hit area reaches beyond the panel edge. 3px keeps it off
       the neighbour's content (a marquee started 5px into the file list is
       the list's, #756); Floating Islands centres it in the gutter. */
    --shift: calc(var(--resize-outward, 3px) * var(--s) * -1);
    --rest: calc(var(--resize-line-width, 1px) * var(--s));
    --w: var(--rest);
    --c: var(--resize-line, var(--layout-hairline, var(--divider)));
    /* The line's offset from the edge, on its inner side: the rest hairline
       covers the edge's inner pixel and a wider bar grows about it. */
    --at: calc(var(--shift) * -1 - (var(--w) - var(--rest)) / 2);
    position: absolute;
    z-index: var(--resize-z, 10);
    touch-action: none;
  }
  .resize-handle:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .resize-handle[data-inset] { --shift: 0px; }
  .resize-handle:is(:hover, :focus-visible), .resize-handle[data-dragging] {
    --w: calc(var(--resize-active-width, 3px) * var(--s));
    --c: var(--resize-active, var(--accent));
  }
  .resize-handle::before {
    content: "";
    position: absolute;
    pointer-events: none;
    background: var(--c);
    /* Rest is immediate; hover and focus wait (below); a drag never does. */
    transition: none;
  }
  .resize-handle:is(:hover, :focus-visible)::before {
    transition-property: width, height, left, right, top, bottom, background-color;
    transition-duration: 80ms;
    transition-delay: var(--resize-hover-delay, 250ms);
  }
  .resize-handle[data-dragging]::before { transition: none; }

  [data-edge="left"], [data-edge="right"] { top: 0; bottom: 0; width: var(--hit); cursor: col-resize; }
  [data-edge="top"], [data-edge="bottom"] { left: 0; right: 0; height: var(--hit); cursor: row-resize; }
  [data-edge="left"] { left: var(--shift); }
  [data-edge="right"] { right: var(--shift); }
  [data-edge="top"] { top: var(--shift); }
  [data-edge="bottom"] { bottom: var(--shift); }
  :is([data-edge="left"], [data-edge="right"])::before { top: 0; bottom: 0; width: var(--w); }
  :is([data-edge="top"], [data-edge="bottom"])::before { left: 0; right: 0; height: var(--w); }
  [data-edge="left"]::before { left: var(--at); }
  [data-edge="right"]::before { right: var(--at); }
  [data-edge="top"]::before { top: var(--at); }
  [data-edge="bottom"]::before { bottom: var(--at); }
</style>
