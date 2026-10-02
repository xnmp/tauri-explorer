<script lang="ts">
  import { cropPixelPoint, type CropEdge, type ImageCropRect, type ImagePixelSize } from "$lib/domain/image-crop";
  interface Props { url: string; name: string; size?: ImagePixelSize; rect?: ImageCropRect; disabled: boolean;
    onload: (size: ImagePixelSize) => void; onerror: () => void; onedge: (edge: CropEdge, value: number) => void }
  let { url, name, size, rect, disabled, onload, onerror, onedge }: Props = $props();
  let scroller = $state<HTMLDivElement>();
  let image = $state<HTMLImageElement>();
  let available = $state({ width: 640, height: 360 });
  let zoom = $state(1);
  let edge = $state<CropEdge | null>(null);
  const edges: readonly CropEdge[] = ["left", "top", "right", "bottom"];
  const scale = $derived(size ? Math.min(1, (available.width - 48) / size.width, (available.height - 48) / size.height) * zoom : 1);
  $effect(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(() => { if (scroller) available = { width: scroller.clientWidth, height: scroller.clientHeight }; });
    observer.observe(scroller);
    return () => observer.disconnect();
  });
  function bounds(edge: CropEdge): readonly [number, number] {
    if (!size || !rect) return [0, 0];
    return { left: [0, rect.right - 1], right: [rect.left + 1, size.width],
      top: [0, rect.bottom - 1], bottom: [rect.top + 1, size.height] }[edge] as [number, number];
  }
  function drag(event: PointerEvent): void {
    if (!edge || disabled || !image || !size) return;
    const point = cropPixelPoint({ x: event.clientX, y: event.clientY }, image.getBoundingClientRect(), size);
    if (point) onedge(edge, edge === "left" || edge === "right" ? point.x : point.y);
  }
  function start(event: PointerEvent, next: CropEdge): void {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    button.focus();
    button.setPointerCapture(event.pointerId);
    edge = next;
    drag(event);
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
  async function measureOriginal(): Promise<void> {
    // WebKit can report a rendered SVG's CSS viewport as its natural size.
    // An unattached image resolves the immutable source's intrinsic viewport
    // before fit/zoom styles participate in layout.
    const original = new Image();
    original.src = url;
    try {
      await original.decode();
      onload({ width: original.naturalWidth, height: original.naturalHeight });
    } catch { onerror(); }
  }
</script>

<div class="crop-view-controls">
  <span>Drag each edge, or use arrow keys (Shift: 10 pixels).</span>
  <button class="btn" disabled={disabled || zoom <= 1} onclick={() => zoom = Math.max(1, zoom / 2)} aria-label="Zoom out crop">−</button>
  <button class="btn" disabled={disabled} onclick={() => zoom = 1}>Fit</button>
  <button class="btn" disabled={disabled || zoom >= 8} onclick={() => zoom = Math.min(8, zoom * 2)} aria-label="Zoom in crop">+</button>
</div>
<div class="crop-scroller" bind:this={scroller}>
  <div class="crop-image" style:width={size ? `${size.width * scale}px` : undefined} style:height={size ? `${size.height * scale}px` : undefined}>
    <img bind:this={image} src={url} alt={name} draggable="false" onload={measureOriginal} {onerror} />
    {#if size && rect}
      <div class="crop-selection" style:left={`${rect.left / size.width * 100}%`} style:top={`${rect.top / size.height * 100}%`}
        style:width={`${(rect.right - rect.left) / size.width * 100}%`} style:height={`${(rect.bottom - rect.top) / size.height * 100}%`}>
        {#each edges as item}
          {@const limits = bounds(item)}
          <button class="crop-edge {item}" role="slider" aria-label={`${item[0].toUpperCase()}${item.slice(1)} crop edge`}
            aria-orientation={item === "top" || item === "bottom" ? "vertical" : "horizontal"}
            aria-valuemin={limits[0]} aria-valuemax={limits[1]} aria-valuenow={rect[item]} aria-valuetext={`${rect[item]} pixels`}
            {disabled} onpointerdown={(event) => start(event, item)} onpointermove={drag}
            onpointerup={() => edge = null} onpointercancel={() => edge = null} onlostpointercapture={() => edge = null}
            onkeydown={(event) => key(event, item)}></button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .crop-view-controls { display: flex; align-items: center; gap: var(--spacing-sm); font-size: var(--font-size-caption); }
  .crop-view-controls span { flex: 1; color: var(--text-secondary); }
  .crop-scroller { height: min(46vh, 480px); min-height: 150px; overflow: auto; border: 1px solid var(--control-stroke); background: var(--background-solid); }
  .crop-image { position: relative; margin: 24px auto; background: repeating-conic-gradient(var(--control-stroke) 0% 25%, var(--background-solid) 0% 50%) 0 0 / 16px 16px; }
  img { display: block; width: 100%; height: 100%; max-width: none; user-select: none; }
  .crop-selection { position: absolute; border: 1px solid var(--accent); box-sizing: border-box; box-shadow: 0 0 0 20000px rgb(0 0 0 / 45%); pointer-events: none; }
  .crop-edge { position: absolute; background: var(--accent); border: 2px solid var(--background-solid); border-radius: var(--radius-sm); pointer-events: auto; touch-action: none; padding: 0; }
  .crop-edge.left, .crop-edge.right { width: 12px; height: 40px; top: calc(50% - 20px); cursor: ew-resize; }
  .crop-edge.top, .crop-edge.bottom { height: 12px; width: 40px; left: calc(50% - 20px); cursor: ns-resize; }
  .crop-edge.left { left: -6px; } .crop-edge.right { right: -6px; } .crop-edge.top { top: -6px; } .crop-edge.bottom { bottom: -6px; }
  .crop-edge:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
</style>
