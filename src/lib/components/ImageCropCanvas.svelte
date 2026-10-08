<script lang="ts">
  import { cropPixelPoint, setCropEdge, translateImageCrop, type CropEdge, type ImageCropRect, type ImagePixelSize } from "$lib/domain/image-crop";
  interface Props {
    url: string; name: string; vector?: boolean; size?: ImagePixelSize; rect?: ImageCropRect; disabled: boolean; showCropControls?: boolean;
    onload: (size: ImagePixelSize) => void; onerror: () => void;
    onedge: (edge: CropEdge, value: number) => void; onselect: (rect: ImageCropRect) => void;
  }
  let { url, name, vector = false, size, rect, disabled, showCropControls = true, onload, onerror, onedge, onselect }: Props = $props();
  let scroller = $state<HTMLDivElement>();
  let image = $state<HTMLImageElement>();
  let available = $state<ImagePixelSize | null>(null);
  let zoom = $state(1);
  let dragging = $state(false);
  const edges: readonly CropEdge[] = ["left", "top", "right", "bottom"];
  const corners = [
    { name: "Top left", x: "left", y: "top" }, { name: "Top right", x: "right", y: "top" },
    { name: "Bottom left", x: "left", y: "bottom" }, { name: "Bottom right", x: "right", y: "bottom" },
  ] as const;
  type Target = CropEdge | typeof corners[number] | "move";
  // Gesture geometry is measured before writes, then refreshed only when the
  // viewport changes. Reading layout on every pointermove forces synchronous
  // reflow after the preceding crop update.
  let gesture: { target: Target; origin: { x: number; y: number }; rect: ImageCropRect; bounds: DOMRect; pointerId: number } | null = null;
  const scale = $derived(size && available ? Math.min(1, Math.max(1, available.width - 48) / size.width, Math.max(1, available.height - 48) / size.height) * zoom : 1);
  const selection = $derived(size && rect ? {
    left: rect.left / size.width * 100, top: rect.top / size.height * 100,
    right: rect.right / size.width * 100, bottom: rect.bottom / size.height * 100,
  } : null);
  function remeasure(): void { if (gesture && image) gesture.bounds = image.getBoundingClientRect(); }
  $effect(() => {
    // Scroll does not bubble. Capture it from every ancestor, including the
    // card on small viewports, because all of them translate the image.
    window.addEventListener("scroll", remeasure, true);
    window.addEventListener("resize", remeasure);
    return () => {
      window.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", remeasure);
    };
  });
  $effect(() => {
    if (!scroller) return;
    const viewportObserver = new ResizeObserver((entries) => {
      const viewport = entries.find((entry) => entry.target === scroller)?.borderBoxSize[0];
      // Fit against the outer viewport, excluding its two 1px borders.
      // Scrollbars belong to zoomed content; measuring the shrinking scroll
      // area feeds their appearance back into fit and delays initial sizing.
      if (viewport) available = { width: Math.floor(viewport.inlineSize) - 2, height: Math.floor(viewport.blockSize) - 2 };
    });
    viewportObserver.observe(scroller, { box: "border-box" });
    // The image observer only reads geometry. It never changes layout.
    const imageObserver = new ResizeObserver(remeasure);
    if (image) imageObserver.observe(image);
    return () => { viewportObserver.disconnect(); imageObserver.disconnect(); };
  });
  function bounds(edge: CropEdge): readonly [number, number] {
    if (!size || !rect) return [0, 0];
    return { left: [0, rect.right - 1], right: [rect.left + 1, size.width],
      top: [0, rect.bottom - 1], bottom: [rect.top + 1, size.height] }[edge] as [number, number];
  }
  function drag(event: PointerEvent): void {
    if (!gesture || gesture.pointerId !== event.pointerId || disabled || !size) return;
    const point = cropPixelPoint({ x: event.clientX, y: event.clientY }, gesture.bounds, size);
    if (!point) return;
    const { target } = gesture;
    if (target === "move") {
      onselect(translateImageCrop(gesture.rect, { x: point.x - gesture.origin.x, y: point.y - gesture.origin.y }, size));
    } else if (typeof target === "string") {
      onedge(target, target === "left" || target === "right" ? point.x : point.y);
    } else {
      onselect(setCropEdge(setCropEdge(gesture.rect, target.x, point.x, size), target.y, point.y, size));
    }
  }
  function start(event: PointerEvent, target: Target): void {
    if (disabled || event.button !== 0 || !image || !size || !rect || gesture) return;
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    button.focus({ preventScroll: true });
    const bounds = image.getBoundingClientRect();
    const origin = cropPixelPoint({ x: event.clientX, y: event.clientY }, bounds, size);
    if (!origin) return;
    button.setPointerCapture(event.pointerId);
    gesture = { target, bounds, origin, rect, pointerId: event.pointerId };
    dragging = true;
  }
  function stop(event: PointerEvent): void {
    if (gesture?.pointerId !== event.pointerId) return;
    // Commit the final pointer location before an immediately following Save.
    if (event.type === "pointerup") drag(event);
    gesture = null;
    dragging = false;
  }
  function key(event: KeyboardEvent, edge: CropEdge): void {
    if (!rect || disabled) return;
    const [min, max] = bounds(edge);
    const vertical = edge === "top" || edge === "bottom";
    const direction = event.key === (vertical ? "ArrowUp" : "ArrowLeft") ? -1 : event.key === (vertical ? "ArrowDown" : "ArrowRight") ? 1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    onedge(edge, event.key === "Home" ? min : event.key === "End" ? max : rect[edge] + direction * (event.shiftKey ? 10 : 1));
  }
  function keySelection(event: KeyboardEvent, corner?: typeof corners[number]): void {
    if (!rect || !size || disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const delta = { x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
      y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 };
    onselect(corner ? setCropEdge(setCropEdge(rect, corner.x, rect[corner.x] + delta.x, size), corner.y, rect[corner.y] + delta.y, size)
      : translateImageCrop(rect, delta, size));
  }
  async function measureOriginal(rendered: HTMLImageElement): Promise<void> {
    // Raster load already established intrinsic dimensions. Re-decoding a
    // second full-resolution image delays tool readiness on large photos.
    if (!vector) {
      onload({ width: rendered.naturalWidth, height: rendered.naturalHeight });
      return;
    }
    // WebKit can report a rendered SVG's CSS viewport as its natural size.
    const original = new Image();
    original.src = url;
    try { await original.decode(); onload({ width: original.naturalWidth, height: original.naturalHeight }); }
    catch { onerror(); }
  }
</script>

<div class="crop-canvas">
  <div class="crop-scroller" bind:this={scroller}>
    <div class="crop-stage">
      <div class="crop-image" class:dragging class:ready={!!size && !!available} style:width={size && available ? `${size.width * scale}px` : "1px"} style:height={size && available ? `${size.height * scale}px` : "1px"}>
        <img bind:this={image} src={url} alt={name} draggable="false" onload={(event) => measureOriginal(event.currentTarget as HTMLImageElement)} {onerror} />
        {#if showCropControls && size && rect && selection}
          <div class="crop-shade" style:inset={`0 0 ${100 - selection.top}% 0`} aria-hidden="true"></div>
          <div class="crop-shade" style:inset={`${selection.bottom}% 0 0 0`} aria-hidden="true"></div>
          <div class="crop-shade" style:inset={`${selection.top}% ${100 - selection.left}% ${100 - selection.bottom}% 0`} aria-hidden="true"></div>
          <div class="crop-shade" style:inset={`${selection.top}% 0 ${100 - selection.bottom}% ${selection.right}%`} aria-hidden="true"></div>
          <div class="crop-selection" style:left={`${selection.left}%`} style:top={`${selection.top}%`}
            style:width={`${selection.right - selection.left}%`} style:height={`${selection.bottom - selection.top}%`}>
            <button class="crop-move" aria-label="Move crop selection" title="Drag to move the selection; arrow keys to nudge" {disabled}
              onpointerdown={(event) => start(event, "move")} onpointermove={drag} onpointerup={stop} onpointercancel={stop} onlostpointercapture={stop}
              onkeydown={(event) => keySelection(event)}></button>
            <svg class="crop-grid" viewBox="0 0 3 3" preserveAspectRatio="none" aria-hidden="true">
              <path d="M1 0v3M2 0v3M0 1h3M0 2h3" vector-effect="non-scaling-stroke" />
            </svg>
            {#each edges as item}
              {@const limits = bounds(item)}
              <button class="crop-edge {item}" role="slider" aria-label={`${item[0].toUpperCase()}${item.slice(1)} crop edge`}
                aria-orientation={item === "top" || item === "bottom" ? "vertical" : "horizontal"}
                aria-valuemin={limits[0]} aria-valuemax={limits[1]} aria-valuenow={rect[item]} aria-valuetext={`${rect[item]} pixels`}
                {disabled} onpointerdown={(event) => start(event, item)} onpointermove={drag}
                onpointerup={stop} onpointercancel={stop} onlostpointercapture={stop} onkeydown={(event) => key(event, item)}></button>
            {/each}
            {#each corners as corner}
              <button class="crop-corner {corner.x} {corner.y}" aria-label={`${corner.name} crop corner`} title={`${corner.name} crop corner`} {disabled}
                onpointerdown={(event) => start(event, corner)} onpointermove={drag} onpointerup={stop} onpointercancel={stop} onlostpointercapture={stop}
                onkeydown={(event) => keySelection(event, corner)}></button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
  <div class="crop-view-controls">
    {#if showCropControls}<span class="crop-hint">Drag edges or corners to crop. Drag inside to move.</span>{/if}
    <div class="crop-zoom" role="group" aria-label="Crop view zoom">
      <button class="btn secondary" disabled={disabled || zoom <= 1} onclick={() => zoom = Math.max(1, zoom / 2)} aria-label="Zoom out crop" title="Zoom out">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button class="btn secondary fit" disabled={disabled} onclick={() => zoom = 1}>Fit</button>
      <button class="btn secondary" disabled={disabled || zoom >= 8} onclick={() => zoom = Math.min(8, zoom * 2)} aria-label="Zoom in crop" title="Zoom in">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14M12 5v14" /></svg>
      </button>
    </div>
  </div>
</div>

<style>
  .crop-canvas { min-width: 0; }
  .crop-view-controls { display: flex; align-items: center; gap: var(--spacing-sm); padding-top: var(--spacing-sm); font-size: var(--font-size-caption); }
  .crop-hint { flex: 1; color: var(--text-secondary); }
  .crop-zoom { display: flex; gap: var(--spacing-xs); flex-shrink: 0; margin-left: auto; }
  .crop-zoom .btn { min-width: 0; width: 28px; height: 28px; padding: 0; font-size: var(--font-size-caption); }
  .crop-zoom .fit { width: auto; padding-inline: var(--spacing-sm); }
  .crop-scroller { height: var(--crop-stage-height, min(calc(50vh / var(--app-zoom, 1)), 460px)); min-height: 120px; overflow: auto; contain: layout paint; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--background-solid), #000 8%); }
  .crop-stage { display: flex; align-items: center; justify-content: center; width: max-content; min-width: 100%; min-height: 100%; padding: 24px; box-sizing: border-box; }
  .crop-image { position: relative; visibility: hidden; flex-shrink: 0; background: repeating-conic-gradient(var(--control-stroke) 0% 25%, var(--background-solid) 0% 50%) 0 0 / 16px 16px; }
  .crop-image.ready { visibility: visible; }
  img { display: block; width: 100%; height: 100%; max-width: none; user-select: none; }
  .crop-shade { position: absolute; background: rgb(0 0 0 / 55%); pointer-events: none; }
  .crop-selection { position: absolute; outline: 1px solid white; pointer-events: none; }
  .crop-move { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; padding: 0; background: transparent; pointer-events: auto; touch-action: none; cursor: move; }
  .crop-grid { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; opacity: 0; }
  .crop-grid path { fill: none; stroke: rgb(255 255 255 / 35%); stroke-width: 1px; }
  .crop-selection:hover .crop-grid, .crop-selection:focus-within .crop-grid, .dragging .crop-grid { opacity: 1; }
  .crop-edge, .crop-corner { position: absolute; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 0; background: transparent; pointer-events: auto; touch-action: none; }
  .crop-edge::before, .crop-corner::before { content: ""; position: absolute; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 65%)); }
  .crop-edge.left, .crop-edge.right { top: calc(50% - 14px); cursor: ew-resize; }
  .crop-edge.top, .crop-edge.bottom { left: calc(50% - 14px); cursor: ns-resize; }
  .crop-edge.left { left: -14px; } .crop-edge.right { right: -14px; }
  .crop-edge.top { top: -14px; } .crop-edge.bottom { bottom: -14px; }
  .crop-edge::before { inset: 6px 12px; background: white; border-radius: 2px; }
  .crop-edge.top::before, .crop-edge.bottom::before { inset: 12px 6px; }
  .crop-corner.left { left: -14px; } .crop-corner.right { right: -14px; }
  .crop-corner.top { top: -14px; } .crop-corner.bottom { bottom: -14px; }
  .crop-corner.left.top, .crop-corner.right.bottom { cursor: nwse-resize; }
  .crop-corner.right.top, .crop-corner.left.bottom { cursor: nesw-resize; }
  .crop-corner::before { width: 12px; height: 12px; border-color: white; border-style: solid; border-width: 0; }
  .crop-corner.left::before { left: 12px; border-left-width: 3px; }
  .crop-corner.right::before { right: 12px; border-right-width: 3px; }
  .crop-corner.top::before { top: 12px; border-top-width: 3px; }
  .crop-corner.bottom::before { bottom: 12px; border-bottom-width: 3px; }
  .crop-edge:focus-visible, .crop-corner:focus-visible, .crop-move:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
</style>
