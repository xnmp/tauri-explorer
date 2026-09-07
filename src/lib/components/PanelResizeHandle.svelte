<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ResizeController } from "$lib/composables/use-resize-owner.svelte";
  let { resize, label, controls, outset = false }: { resize: ResizeController; label: string; controls: string; outset?: boolean } = $props();
  onDestroy(untrack(() => resize.cancel));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is an interactive range. -->
<div class="resize-handle" class:outset class:resizing={resize.isResizing}
  role="separator" tabindex="0" aria-orientation="vertical" aria-label={label}
  aria-controls={controls} aria-valuemin={resize.min} aria-valuemax={resize.max}
  aria-valuenow={resize.value} aria-valuetext={`${Math.round(resize.value)} pixels`}
  onpointerdown={resize.startResize} onpointermove={resize.move} onpointerup={resize.finish}
  onpointercancel={resize.cancelPointer} onlostpointercapture={resize.cancelPointer}
  onkeydown={resize.keydown}></div>

<style>
  .resize-handle { position: absolute; right: 0; top: 0; bottom: 0; width: 4px;
    cursor: ew-resize; touch-action: none; z-index: 1; background: transparent; }
  .outset { right: -3px; width: 6px; z-index: 10; }
  .resize-handle:hover, .resizing { background: var(--accent); }
  .resize-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
