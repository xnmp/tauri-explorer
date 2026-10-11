<!--
  The Preview pane's image surface, shared by file images and plugin Preview
  targets (#1033). It owns click/pan/zoom through the pane's fullscreen
  controller; the pane's double-click policy leaves it alone. Clicking at fit
  zoom toggles fullscreen (#219).
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { PreviewFullscreen } from "$lib/composables/use-preview-fullscreen.svelte";

  interface Props {
    src: string;
    alt: string;
    fullscreen: PreviewFullscreen;
    /** Overlays drawn over the image (notes, a loading spinner). */
    children?: Snippet;
  }

  let { src, alt, fullscreen, children }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="preview-image-container"
  class:fullscreen={fullscreen.active}
  class:panning={fullscreen.panning}
  bind:this={fullscreen.container}
  onwheel={fullscreen.wheel}
  onclick={fullscreen.click}
  onpointerdown={fullscreen.pointerDown}
  onpointermove={fullscreen.pointerMove}
  onpointerup={fullscreen.pointerUp}
  onpointercancel={fullscreen.pointerUp}
>
  <img
    {src}
    {alt}
    class="preview-image"
    class:zoomed={fullscreen.active && fullscreen.zoom > 1}
    style:transform={fullscreen.transform}
    draggable="false"
  />
  {@render children?.()}
  {#if fullscreen.active}
    <div class="fs-zoom-indicator">{Math.round(fullscreen.zoom * 100)}%</div>
  {/if}
</div>

<style>
  .preview-image-container {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    /* Let the image shrink to the content area's available height instead of
       expanding this flex item and forcing the preview pane to scroll. */
    min-height: 0;
    padding: 20px;
    /* Click toggles front-and-center (#219). */
    cursor: zoom-in;
    background:
      repeating-conic-gradient(
        rgba(255, 255, 255, 0.03) 0% 25%,
        transparent 0% 50%
      ) 50% / 12px 12px;
  }

  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-card);
  }

  /* Fullscreen: fill the whole fullscreen pane and centre the image both
     ways, independent of the flex chain; drop the padding and the image's
     rounded corners so it fills the screen symmetrically. */
  .preview-image-container.fullscreen {
    position: absolute;
    inset: 0;
    min-height: 0;
    overflow: hidden;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }
  .fullscreen .preview-image {
    border-radius: 0;
    box-shadow: none;
    transition: transform 80ms ease-out;
    cursor: zoom-in;
  }
  .fullscreen .preview-image.zoomed {
    cursor: grab;
    transition: none;
    /* Pan and wheel-zoom update this transform for every pointer event. Keep
       the active image on its own compositor layer instead of repainting the
       preview surface on each update (#635). */
    will-change: transform;
  }
  .preview-image-container.fullscreen.panning,
  .preview-image-container.fullscreen.panning .preview-image {
    cursor: grabbing;
  }

  .fs-zoom-indicator {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 12px;
    border-radius: var(--radius-pill, 999px);
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
</style>
