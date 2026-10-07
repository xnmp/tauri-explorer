<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { imageEditorRegistry, type ImageEditorSource } from "$lib/plugins/image-editor-registry.svelte";
  import Modal from "./Modal.svelte";
  import ImageCropCanvas from "./ImageCropCanvas.svelte";
  import { captureImageCrop, saveImageCrop } from "$lib/api/image-crop";
  import { dataUriToBlobUrl } from "$lib/api/common";
  import { createImageCropSession, croppedCopyName, type ImageCropSessionState } from "$lib/state/image-crop-session";
  import { croppedImageSize, type CropEdge } from "$lib/domain/image-crop";
  import { publishImageCrop } from "$lib/state/image-crop-effects";

  let { path, name, previewUrl, referencePaths = [], initialTool = "crop", onSelectSource, onclose }: { path: string; name: string; previewUrl?: string | null; referencePaths?: string[]; initialTool?: string; onSelectSource?: (path: string) => void; onclose: () => void } = $props();
  // The component is keyed by the editor opening, never by live selection.
  const sourcePath = untrack(() => path);
  const sourceName = untrack(() => name);
  const openingPreview = untrack(() => previewUrl);
  let editorState = $state<ImageCropSessionState>({ phase: "loading", name: sourceName });
  let copyName = $state(croppedCopyName(sourceName));
  let confirmReplace = $state(false);
  const activeTool = untrack(() => initialTool);
  let toolBusy = $state(false);
  const source = $derived<ImageEditorSource | null>(editorState.capture ? {
    path: editorState.capture.path, name: sourceName, digest: editorState.capture.revision.digest,
    format: editorState.capture.format, size: editorState.size, referencePaths,
  } : null);
  const tools = $derived(source ? imageEditorRegistry.toolsFor(source) : []);
  const selectedTool = $derived(tools.find((tool) => tool.id === activeTool));
  const cropping = activeTool === "crop";
  const editorTitle = $derived(cropping ? "Edit image" : selectedTool?.title || "AI edit");
  // Disabling a provider removes its panel; accepted jobs remain owned by Jobs.
  $effect(() => { if (source && activeTool !== "crop" && !selectedTool) toolBusy = false; });
  const busy = $derived(toolBusy || editorState.phase === "saving" || editorState.phase === "loading");
  const output = $derived(editorState.rect ? croppedImageSize(editorState.rect) : null);
  const session = createImageCropSession({
    capture: captureImageCrop, save: saveImageCrop, createUrl: dataUriToBlobUrl,
    revokeUrl: (url) => URL.revokeObjectURL(url),
    changed: (next) => { editorState = next; },
    closed: () => onclose(),
    saved: publishImageCrop,
  });
  onMount(() => { void session.open(sourcePath, sourceName); });
  onDestroy(() => session.dispose());
  function close(): void { if (!toolBusy && editorState.phase !== "saving") session.close(); }
  function commitPosition(input: HTMLInputElement, edge: CropEdge): void {
    session.edge(edge, input.valueAsNumber);
    // Intermediate text belongs to the native input until blur or Enter.
    // Restore invalid input and normalize clamped coordinates at that boundary.
    if (session.state.rect) input.value = String(session.state.rect[edge]);
  }
  const edges: readonly CropEdge[] = ["left", "top", "right", "bottom"];
</script>

<Modal open={true} onClose={close} canClose={() => !toolBusy && editorState.phase !== "saving"} label={editorTitle} overlayClass="image-crop-overlay" closeOnBackdrop={false} closeOnEscape={!toolBusy && editorState.phase !== "saving"}>
  <div class="modal-card crop-editor" aria-busy={busy}>
    <div class="dialog-header">
      <div class="crop-title">
        <h2>{editorTitle}</h2>
        <p class="dialog-subtitle" title={sourcePath}>{sourceName} {editorState.size ? `· ${editorState.size.width} × ${editorState.size.height}` : ""}</p>
      </div>
      <button class="btn secondary crop-close" aria-label="Close image editor" title="Close" disabled={toolBusy || editorState.phase === "saving"} onclick={close}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
    {#if referencePaths.length && onSelectSource}
      <label class="edit-target">Edit target
        <select aria-label="Edit target" value={sourcePath} disabled={busy} onchange={(event) => onSelectSource?.(event.currentTarget.value)}>
          {#each [sourcePath, ...referencePaths] as input}<option value={input}>{input.split(/[\\/]/).pop()}</option>{/each}
        </select>
      </label>
    {/if}
    <div class:ai-layout={!cropping} class="editor-workspace">
    <div class="editor-image">
    {#if editorState.phase === "loading"}
      <div class="crop-loading-stage">
        {#if openingPreview}<img class="crop-loading-image" src={openingPreview} alt={sourceName} />{/if}
        <span class="crop-loading-status" role="status">Loading original image…</span>
      </div>
    {:else if editorState.url}
      <ImageCropCanvas url={editorState.url} name={sourceName} size={editorState.size} rect={cropping ? editorState.rect : editorState.size ? { left: 0, top: 0, right: editorState.size.width, bottom: editorState.size.height } : undefined} disabled={busy || confirmReplace || !cropping} showCropControls={cropping} vector={editorState.capture?.format === "SVG"}
        onload={session.loaded} onerror={session.failedPreview} onedge={session.edge} onselect={session.select} />
    {/if}
    {#if cropping && editorState.rect && editorState.size}
      <div class="crop-dimensions">
        {#each edges as edge}
          <label>{edge[0].toUpperCase()}{edge.slice(1)}
            <input type="number" aria-label={`${edge} pixel position`} min="0" max={edge === "left" || edge === "right" ? editorState.size.width : editorState.size.height}
              step="1" value={editorState.rect[edge]} disabled={busy || confirmReplace}
              onchange={(event) => commitPosition(event.currentTarget, edge)}
              onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitPosition(event.currentTarget, edge); } }} />
          </label>
        {/each}
        <span class="crop-output" role="status">Selected: {output?.width} × {output?.height} px</span>
        <button class="btn secondary crop-reset" disabled={busy || confirmReplace} onclick={session.reset} title="Restore the full image">Reset</button>
      </div>
      {#if editorState.capture?.format === "ICNS"}
        <p class="crop-note">ICNS retains each original icon size. The selected region is centered with transparent padding; largest output canvas: {editorState.size.width} × {editorState.size.height} px.</p>
      {:else if editorState.capture?.format === "AVIF"}
        <p class="crop-note">First-frame crop preview. Saving retains AVIF format, all frames, timing, color and HDR metadata.</p>
      {/if}
    {/if}
    </div>
    {#if selectedTool && source}
      <section class="editor-ai plugin-dialog" aria-label={selectedTool.title}>
        {#key selectedTool}
          {@const Tool = selectedTool.component}
          <Tool {...selectedTool.props} {source} onClose={() => { toolBusy = false; session.close(); }} onBusyChange={(value: boolean) => { toolBusy = value; }} />
        {/key}
      </section>
    {:else if source && !cropping}
      <p class="crop-note" role="status">This image editor is unavailable.</p>
    {/if}
    </div>
    {#if editorState.error}<p class="error-message" role="alert">{editorState.error}</p>{/if}
    {#if cropping}
    {#if confirmReplace}
      <div class="crop-confirm" role="group" aria-label="Confirm replacement">
        <p>Replace <strong>{sourceName}</strong> with this crop? This changes the original image.</p>
        <div class="crop-actions">
          <button class="btn secondary" disabled={busy} data-autofocus onclick={() => confirmReplace = false}>Keep editing</button>
          <button class="btn danger" disabled={busy} onclick={() => { void session.save({ kind: "replace" }); }}>Confirm replacement</button>
        </div>
      </div>
    {:else}
      <div class="crop-footer">
        <label class="crop-copy-name">Copy filename
          <input bind:value={copyName} disabled={busy} spellcheck="false" />
        </label>
        <div class="crop-actions">
          <button class="btn secondary" disabled={toolBusy || editorState.phase === "saving"} onclick={close}>Cancel</button>
          <button class="btn secondary" disabled={busy || !editorState.rect || !editorState.capture} onclick={() => confirmReplace = true}>Replace original…</button>
          <button class="btn primary" disabled={busy || !editorState.rect || !editorState.capture || !copyName.trim()}
            onclick={() => { void session.save({ kind: "copy", name: copyName }); }}>Save copy</button>
        </div>
      </div>
    {/if}
    {/if}
    {#if editorState.phase === "saving"}<p class="crop-note" role="status">Saving crop…</p>{/if}
  </div>
</Modal>

<style>
  .edit-target { margin: 0 0 12px; }
  .edit-target select { color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); padding: 6px; border-radius: var(--radius-sm); }
  .editor-workspace { flex-shrink: 0; }
  .editor-workspace.ai-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: 18px; }
  .editor-image { min-width: 0; }
  .editor-ai { min-width: 0; max-height: calc(75vh / var(--app-zoom, 1)); overflow: auto; }
  @media (max-width: 740px) { .editor-workspace.ai-layout { grid-template-columns: minmax(0, 1fr); } .editor-ai { max-height: none; } }

  /* Cancel root zoom on the overlay, restore it on the viewport-bounded card. */
  :global(.image-crop-overlay) { zoom: calc(1 / var(--app-zoom, 1)); }
  .crop-editor { --crop-stage-height: min(calc(50vh / var(--app-zoom, 1)), 460px); zoom: var(--app-zoom, 1); width: min(960px, calc(100vw / var(--app-zoom, 1) - 32px)); min-width: 0; max-width: none; max-height: calc(100vh / var(--app-zoom, 1) - 32px); overflow: auto; display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-lg); background: var(--background-solid); backdrop-filter: none; animation: none; }
  .crop-editor .dialog-header { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); margin-bottom: 0; }
  .crop-loading-stage { position: relative; height: var(--crop-stage-height); min-height: 120px; flex-shrink: 0; padding: 24px; box-sizing: border-box; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--background-solid), #000 8%); }
  .crop-loading-image { display: block; width: 100%; height: 100%; object-fit: contain; }
  .crop-loading-status { position: absolute; bottom: var(--spacing-md); left: 50%; transform: translateX(-50%); padding: var(--spacing-xs) var(--spacing-sm); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--background-solid); color: var(--text-secondary); font-size: var(--font-size-caption); white-space: nowrap; }
  .crop-title { min-width: 0; }
  .dialog-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crop-editor .crop-close { min-width: 0; width: 28px; height: 28px; padding: 0; flex-shrink: 0; }
  .crop-dimensions { display: flex; align-items: end; flex-wrap: wrap; gap: var(--spacing-sm); }
  label { display: flex; flex-direction: column; gap: var(--spacing-xs); font-size: var(--font-size-caption); color: var(--text-secondary); }
  input { min-width: 0; box-sizing: border-box; height: 32px; padding: var(--spacing-xs) var(--spacing-sm); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; }
  input:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .crop-dimensions input { width: 6em; font-variant-numeric: tabular-nums; }
  .crop-output { margin: auto 0 auto auto; color: var(--text-secondary); font-size: var(--font-size-caption); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .crop-editor .crop-reset { min-width: 0; height: 32px; padding: var(--spacing-xs) var(--spacing-sm); font-size: var(--font-size-caption); }
  .crop-note { color: var(--text-secondary); font-size: var(--font-size-caption); margin: 0; }
  .crop-footer { display: flex; align-items: end; gap: var(--spacing-lg); padding-top: var(--spacing-md); border-top: 1px solid var(--divider); }
  .crop-copy-name { flex: 1; min-width: 120px; }
  .crop-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--spacing-sm); }
  .crop-editor .crop-actions .btn { min-width: 0; height: 32px; padding: var(--spacing-xs) var(--spacing-md); font-size: var(--font-size-caption); }
  .crop-confirm { border: 1px solid var(--control-stroke); padding: var(--spacing-md); border-radius: var(--radius-sm); }
  .crop-confirm p { margin: 0 0 var(--spacing-md); font-size: var(--font-size-caption); }
  @media (max-height: 600px) { .crop-editor { --crop-stage-height: max(120px, calc(100vh / var(--app-zoom, 1) - 280px)); } }
  @media (max-width: 700px) { .crop-footer { flex-wrap: wrap; gap: var(--spacing-md); } .crop-copy-name { flex-basis: 100%; } .crop-actions { margin-left: auto; } .crop-output { margin-left: 0; } }
  @media (max-width: 480px) { .crop-editor { padding: var(--spacing-md); } }
</style>
