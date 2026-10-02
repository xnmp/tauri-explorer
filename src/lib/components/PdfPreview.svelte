<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { loadPdf, openPdfLink, type PdfLink } from "$lib/api/pdf-preview";
  import { toastStore } from "$lib/state/toast.svelte";
  import { createPdfPreview, createPdfRenderLifetime } from "$lib/state/pdf-preview.svelte";
  import { PDF_FIT, fitPdfScale, panPdf, pdfPointerPoint, resizePdfView, zoomPdf, type PdfView, type Size } from "$lib/domain/pdf-preview";
  import { dialogStore } from "$lib/state/dialogs.svelte";

  const { path, name, fullscreen, ontogglefullscreen, onnavigate }: {
    path: string; name: string; fullscreen: boolean; ontogglefullscreen(): void; onnavigate(delta: number): void;
  } = $props();
  const preview = createPdfPreview(loadPdf);
  const rendering = createPdfRenderLifetime();
  let viewportEl = $state<HTMLElement | null>(null);
  let canvasHost = $state<HTMLElement | null>(null);
  let viewport = $state<Size>({ width: 0, height: 0 });
  let view = $state<PdfView>(PDF_FIT);
  let renderError = $state<string | null>(null);
  let renderedPage = $state.raw<object | null>(null);
  let panning = $state(false);
  let gesture: { id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; link: number | null } | null = null;
  let releasedLink: number | null = null;
  let suppressClick = false;
  const page = $derived(preview.state.page);
  const scale = $derived(page ? fitPdfScale(page.size, viewport) * view.zoom : 0);
  const width = $derived(page ? page.size.width * scale : 0);
  const height = $derived(page ? page.size.height * scale : 0);
  const ready = $derived(!!page && renderedPage === page && !renderError && !preview.state.error);

  $effect(() => {
    const selectedPath = path;
    // The selected path owns this effect; imperative lifecycle reads must not subscribe it to its own output.
    untrack(() => { void preview.open(selectedPath); });
    return () => rendering.cancel();
  });
  $effect(() => {
    if (!viewportEl) return;
    const element = viewportEl;
    const observer = new ResizeObserver(() => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (page) view = resizePdfView(view, page.size, viewport, next);
      viewport = next;
      cancelPan();
    });
    observer.observe(element);
    return () => observer.disconnect();
  });
  $effect(() => {
    void page;
    view = PDF_FIT; renderedPage = null; renderError = null; cancelPan();
  });
  $effect(() => {
    if (!page || !scale || !canvasHost) { rendering.cancel(); return; }
    const targetPage = page;
    const host = canvasHost;
    const surfaceScale = viewportEl ? viewportEl.getBoundingClientRect().width / viewportEl.clientWidth : 1;
    const job = targetPage.render(scale, (window.devicePixelRatio || 1) * surfaceScale);
    void rendering.render(job, canvas => {
      host.replaceChildren(canvas); renderedPage = targetPage; renderError = null;
    }, error => { renderError = error; renderedPage = null; });
    return () => rendering.cancel();
  });

  function cancelPan(): void {
    if (gesture && viewportEl?.hasPointerCapture(gesture.id)) viewportEl.releasePointerCapture(gesture.id);
    if (gesture) suppressClick = true;
    releasedLink = null;
    gesture = null; panning = false;
  }
  function changeZoom(next: number, anchor = { x: 0, y: 0 }): void {
    if (page) view = zoomPdf(view, next, anchor, page.size, viewport);
  }
  function point(event: MouseEvent): { x: number; y: number } {
    return viewportEl ? pdfPointerPoint({ x: event.clientX, y: event.clientY }, viewportEl.getBoundingClientRect(), viewport) : { x: 0, y: 0 };
  }
  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !page || !ready) return;
    viewportEl?.focus({ preventScroll: true });
    suppressClick = false;
    releasedLink = null;
    if (view.zoom <= 1) return;
    const start = point(event);
    gesture = { id: event.pointerId, startX: start.x, startY: start.y,
      lastX: start.x, lastY: start.y, moved: false,
      link: event.target instanceof Element && event.target.closest<HTMLElement>("[data-pdf-link]")
        ? Number(event.target.closest<HTMLElement>("[data-pdf-link]")!.dataset.pdfLink) : null };
    panning = true;
    viewportEl?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function pointerMove(event: PointerEvent): void {
    if (!gesture || gesture.id !== event.pointerId || !page) return;
    const current = point(event);
    const dx = current.x - gesture.lastX;
    const dy = current.y - gesture.lastY;
    gesture.moved ||= Math.hypot(current.x - gesture.startX, current.y - gesture.startY) > 3;
    view = panPdf(view, { x: dx, y: dy }, page.size, viewport);
    gesture.lastX = current.x; gesture.lastY = current.y;
  }
  function pointerUp(event: PointerEvent): void {
    if (!gesture || gesture.id !== event.pointerId) return;
    pointerMove(event);
    suppressClick = gesture.moved;
    releasedLink = gesture.link;
    const id = gesture.id;
    gesture = null; panning = false;
    if (viewportEl?.hasPointerCapture(id)) viewportEl.releasePointerCapture(id);
  }
  async function activateLink(link: PdfLink): Promise<void> {
    if (link.destination) await preview.navigate(link.destination);
    else if (link.url) {
      try { await openPdfLink(link.url); }
      catch (error) { toastStore.error(`Cannot open PDF link: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  function click(event: MouseEvent): void {
    const target = event.target;
    const linkElement = target instanceof Element ? target.closest<HTMLAnchorElement>("a[data-pdf-link]") : null;
    // This viewing surface owns both gestures and activation. A drag release never activates its starting link.
    if (linkElement) event.preventDefault();
    const linkIndex = linkElement ? Number(linkElement.dataset.pdfLink) : releasedLink;
    releasedLink = null;
    if (suppressClick) { suppressClick = false; return; }
    if (linkIndex !== null && page) {
      const link = page.links[linkIndex];
      if (link) void activateLink(link);
    } else if (ready && view.zoom === 1) ontogglefullscreen();
  }
  function wheel(event: WheelEvent): void {
    if (!page || !viewportEl) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const current = point(event);
      const anchor = { x: current.x - viewport.width / 2, y: current.y - viewport.height / 2 };
      changeZoom(view.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), anchor);
    } else if (view.zoom > 1) {
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
      view = panPdf(view, { x: -event.deltaX * units, y: -event.deltaY * units }, page.size, viewport);
    } else if (event.deltaY) {
      void preview.selectPage(preview.state.pageNumber + Math.sign(event.deltaY));
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement) return;
    let handled = true;
    if (event.key === "+" || event.key === "=") changeZoom(view.zoom + 0.1);
    else if (event.key === "-" || event.key === "_") changeZoom(view.zoom - 0.1);
    else if (event.key === "0") view = PDF_FIT;
    else if (event.key === "PageDown") void preview.selectPage(preview.state.pageNumber + 1);
    else if (event.key === "PageUp") void preview.selectPage(preview.state.pageNumber - 1);
    else if (event.key === "Home") void preview.selectPage(1);
    else if (event.key === "End") void preview.selectPage(preview.state.pageCount);
    else if (event.key === "Enter" && event.target === viewportEl) ontogglefullscreen();
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      if (view.zoom > 1 && page) view = panPdf(view, {
        x: event.key === "ArrowLeft" ? 60 : event.key === "ArrowRight" ? -60 : 0,
        y: event.key === "ArrowUp" ? 60 : event.key === "ArrowDown" ? -60 : 0 }, page.size, viewport);
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") onnavigate(event.key === "ArrowLeft" ? -1 : 1);
    } else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }
  $effect(() => {
    if (!fullscreen) return;
    const listener = (event: KeyboardEvent) => {
      if (dialogStore.hasModalOpen || event.target instanceof Element && event.target.closest("button, a, input, textarea, select, [contenteditable]")) return;
      keydown(event);
      if (event.defaultPrevented) event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  });
  onDestroy(() => { cancelPan(); rendering.dispose(); preview.dispose(); });
</script>

<svelte:window onblur={cancelPan} />
<div class="pdf-preview" data-path={path}>
  <div class="pdf-controls" role="group" aria-label="PDF viewing controls">
    <div class="pdf-control-group">
      <button type="button" aria-label="Previous PDF page" disabled={preview.state.pageNumber <= 1 || preview.state.loading} onclick={() => preview.selectPage(preview.state.pageNumber - 1)}>‹</button>
      <span class="page-count" aria-live="polite">{preview.state.pageNumber} / {preview.state.pageCount || "…"}</span>
      <button type="button" aria-label="Next PDF page" disabled={preview.state.pageNumber >= preview.state.pageCount || preview.state.loading} onclick={() => preview.selectPage(preview.state.pageNumber + 1)}>›</button>
    </div>
    <div class="pdf-control-group">
      <button type="button" aria-label="Zoom PDF out" disabled={!page || view.zoom <= 1} onclick={() => changeZoom(view.zoom - 0.1)}>−</button>
      <output class="pdf-zoom" aria-label="PDF magnification">{Math.round(view.zoom * 100)}%</output>
      <button type="button" aria-label="Zoom PDF in" disabled={!page || view.zoom >= 8} onclick={() => changeZoom(view.zoom + 0.1)}>+</button>
      <button type="button" class="fit-button" disabled={!page} onclick={() => { view = PDF_FIT; cancelPan(); }}>Fit</button>
    </div>
    <button type="button" aria-label={fullscreen ? "Exit PDF fullscreen" : "View PDF fullscreen"} disabled={!page} onclick={ontogglefullscreen}>⛶</button>
  </div>
  <!-- The viewport is a keyboard focusable document interaction surface. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="pdf-viewport" class:grabbable={view.zoom > 1} class:panning bind:this={viewportEl}
    role="region" aria-label={`${name}, PDF page ${preview.state.pageNumber}`} tabindex="0"
    onkeydown={keydown} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp}
    onpointercancel={cancelPan} onlostpointercapture={() => { if (gesture) cancelPan(); }} onclick={click} onwheel={wheel}>
    {#if preview.state.error || renderError}
      <div class="pdf-message" role="alert">Cannot preview PDF: {preview.state.error || renderError}</div>
    {:else if preview.state.loading || !ready}
      <div class="pdf-message" role="status">Loading PDF…</div>
    {/if}
    <div class="pdf-page" class:ready style:width={`${width}px`} style:height={`${height}px`}
      style:transform={`translate(calc(-50% + ${view.pan.x}px), calc(-50% + ${view.pan.y}px))`}>
      <div class="pdf-canvas" bind:this={canvasHost}></div>
      {#if page && ready}
        {#each page.links as link, index}
          <a class="pdf-link" data-pdf-link={index} href={link.url || "#"} aria-label={link.label}
            title={link.label} draggable="false" style:left={`${link.rect[0] * scale}px`} style:top={`${link.rect[1] * scale}px`}
            style:width={`${link.rect[2] * scale}px`} style:height={`${link.rect[3] * scale}px`}></a>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .pdf-preview { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .pdf-controls { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-secondary); }
  .pdf-control-group { display: flex; align-items: center; gap: 2px; }
  button { border: 0; background: transparent; color: var(--text-secondary); min-width: 28px; height: 28px; padding: 0 6px; border-radius: 4px; font: inherit; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, .pdf-link:focus-visible, .pdf-viewport:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .grabbable .pdf-page { will-change: transform; }
  .page-count, .pdf-zoom { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; text-align: center; }
  .page-count { min-width: 38px; } .pdf-zoom { min-width: 38px; }
  .fit-button { font-size: 11px; }
  .pdf-viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; touch-action: none; user-select: none; }
  .grabbable, .grabbable .pdf-link { cursor: grab; } .panning, .panning .pdf-link { cursor: grabbing; }
  .pdf-page { position: absolute; left: 50%; top: 50%; background: white; opacity: 0; box-shadow: 0 1px 6px #0003; }
  .pdf-page.ready { opacity: 1; }
  .pdf-canvas, .pdf-canvas :global(canvas) { display: block; width: 100%; height: 100%; }
  .pdf-link { position: absolute; cursor: pointer; }
  .pdf-link:hover { outline: 1px solid var(--accent); }
  .pdf-message { position: absolute; inset: 0; display: flex; justify-content: center; align-items: center; padding: 20px; text-align: center; color: var(--text-secondary); font-size: 12px; }
</style>
