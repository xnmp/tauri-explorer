<script lang="ts">
  /**
   * Sandboxed HTML document preview with page zoom (#1332, #1352).
   * The frame is laid out at pane / scale and painted scaled, so it always
   * fills the pane and the document scrolls inside it; see html-preview-zoom.
   */
  import { htmlPreviewFrame, htmlZoomLabel, stepHtmlZoom, type HtmlZoom } from "$lib/domain/html-preview-zoom";

  interface Props {
    source: string;
    fullscreen: boolean;
    ontogglefullscreen: () => void;
  }

  let { source, fullscreen, ontogglefullscreen }: Props = $props();

  // Each mounted document starts at Fit; PreviewPane keys this per file.
  let zoom = $state<HtmlZoom>("fit");
  let paneWidth = $state(0);
  let paneHeight = $state(0);

  const frame = $derived(htmlPreviewFrame(zoom, { width: paneWidth, height: paneHeight }));
  const zoomOut = $derived(stepHtmlZoom(zoom, paneWidth, -1));
  const zoomIn = $derived(stepHtmlZoom(zoom, paneWidth, 1));
  // No scripts or same-origin access: file markup must never reach the
  // Explorer document or IPC. CSP also prevents remote subresources; inline
  // styles and embedded images keep self-contained pages useful.
  const srcdoc = $derived(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">${source}`);
</script>

<div class="html-preview">
  <div class="html-controls" role="group" aria-label="HTML viewing controls">
    <div class="html-control-group">
      <button type="button" aria-label="Zoom HTML out" disabled={zoomOut === null} onclick={() => { if (zoomOut !== null) zoom = zoomOut; }}>−</button>
      <output class="html-zoom" aria-label="HTML magnification">{htmlZoomLabel(zoom, paneWidth)}</output>
      <button type="button" aria-label="Zoom HTML in" disabled={zoomIn === null} onclick={() => { if (zoomIn !== null) zoom = zoomIn; }}>+</button>
      <button type="button" class="text-button" aria-pressed={zoom === "fit"} onclick={() => (zoom = "fit")}>Fit</button>
      <button type="button" class="text-button" aria-pressed={zoom === 1} onclick={() => (zoom = 1)}>100%</button>
    </div>
    <button type="button" aria-label={fullscreen ? "Exit HTML fullscreen" : "View HTML fullscreen"} onclick={ontogglefullscreen}>⛶</button>
  </div>
  <div class="html-viewport" bind:clientWidth={paneWidth} bind:clientHeight={paneHeight}>
    <iframe class="preview-html" class:measured={paneWidth > 0} title="HTML preview" sandbox="" referrerpolicy="no-referrer"
      style:width={`${frame.width}px`} style:height={`${frame.height}px`} style:transform={`scale(${frame.scale})`}
      {srcdoc}></iframe>
  </div>
</div>

<style>
  .html-preview { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .html-controls { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-secondary); }
  .html-control-group { display: flex; align-items: center; gap: 2px; }
  button { border: 0; background: transparent; color: var(--text-secondary); min-width: 28px; height: 28px; padding: 0 6px; border-radius: 4px; font: inherit; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  button:disabled { opacity: .4; cursor: default; }
  button[aria-pressed="true"] { color: var(--text-primary); background: var(--subtle-fill-secondary); }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .text-button { font-size: 11px; }
  .html-zoom { min-width: 38px; font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; text-align: center; }
  .html-viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; background: white; }
  /* Laid out at pane / scale, painted at scale: exactly covers the viewport. */
  .preview-html { position: absolute; left: 0; top: 0; border: 0; background: white; transform-origin: 0 0; visibility: hidden; }
  .preview-html.measured { visibility: visible; }
</style>
