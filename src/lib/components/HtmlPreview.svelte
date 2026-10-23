<script lang="ts">
  /**
   * Sandboxed HTML document preview with page zoom (#1332, #1352).
   * The frame lays out a desktop-width page and zoom scales its paint; the pane
   * scrolls horizontally when it is magnified past the pane width, the
   * document scrolls vertically inside the frame; see html-preview-zoom.
   */
  import { htmlPreviewFrame, htmlZoomLabel, stepHtmlZoom, type HtmlZoom } from "$lib/domain/html-preview-zoom";

  interface Props {
    source: string;
    zoom: HtmlZoom;
    onzoom: (zoom: HtmlZoom) => void;
    fullscreen: boolean;
    ontogglefullscreen: () => void;
  }

  let { source, zoom, onzoom, fullscreen, ontogglefullscreen }: Props = $props();

  // PreviewPane owns the zoom so a reload remount of the same file keeps it.
  let paneWidth = $state(0);

  const frame = $derived(htmlPreviewFrame(zoom, paneWidth));
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
      <button type="button" aria-label="Zoom HTML out" disabled={zoomOut === null} onclick={() => { if (zoomOut !== null) onzoom(zoomOut); }}>−</button>
      <output class="html-zoom" aria-label="HTML magnification">{htmlZoomLabel(zoom, paneWidth)}</output>
      <button type="button" aria-label="Zoom HTML in" disabled={zoomIn === null} onclick={() => { if (zoomIn !== null) onzoom(zoomIn); }}>+</button>
      <button type="button" class="text-button" aria-pressed={zoom === "fit"} onclick={() => onzoom("fit")}>Fit</button>
      <button type="button" class="text-button" aria-pressed={zoom === 1} onclick={() => onzoom(1)}>100%</button>
    </div>
    <button type="button" aria-label={fullscreen ? "Exit HTML fullscreen" : "View HTML fullscreen"} onclick={ontogglefullscreen}>⛶</button>
  </div>
  <div class="html-viewport" bind:clientWidth={paneWidth}>
    <!-- Heights stay in CSS: the canvas fills the visible height (excluding a
         horizontal scrollbar), and the frame lays out at that height / scale. -->
    <div class="html-canvas" style:width={`${frame.paintedWidth}px`}>
      <iframe class="preview-html" class:measured={paneWidth > 0} title="HTML preview" sandbox="" referrerpolicy="no-referrer"
        style:width={`${frame.width}px`} style:height={`calc(100% / ${frame.scale})`} style:transform={`scale(${frame.scale})`}
        {srcdoc}></iframe>
    </div>
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
  .html-viewport { position: relative; flex: 1; min-height: 0; overflow-x: auto; overflow-y: hidden; background: white; }
  /* The canvas reserves the scaled frame's painted box for horizontal scrolling. */
  .html-canvas { position: relative; height: 100%; overflow: hidden; }
  .preview-html { position: absolute; left: 0; top: 0; border: 0; background: white; transform-origin: 0 0; visibility: hidden; }
  .preview-html.measured { visibility: visible; }
</style>
