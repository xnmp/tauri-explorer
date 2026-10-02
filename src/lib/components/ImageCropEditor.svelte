<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import ImageCropCanvas from "./ImageCropCanvas.svelte";
  import { captureImageCrop, saveImageCrop } from "$lib/api/image-crop";
  import { dataUriToBlobUrl } from "$lib/api/common";
  import { createImageCropSession, croppedCopyName, type ImageCropSessionState } from "$lib/state/image-crop-session";
  import { croppedImageSize, type CropEdge } from "$lib/domain/image-crop";
  import { publishImageCrop } from "$lib/state/image-crop-effects";

  let { path, name, onclose }: { path: string; name: string; onclose: () => void } = $props();
  // The component is keyed by the editor opening, never by live selection.
  const sourcePath = untrack(() => path);
  const sourceName = untrack(() => name);
  let editorState = $state<ImageCropSessionState>({ phase: "loading", name: sourceName });
  let copyName = $state(croppedCopyName(sourceName));
  let confirmReplace = $state(false);
  const busy = $derived(editorState.phase === "saving" || editorState.phase === "loading");
  const output = $derived(editorState.rect ? croppedImageSize(editorState.rect) : null);
  const session = createImageCropSession({
    capture: captureImageCrop, save: saveImageCrop, createUrl: dataUriToBlobUrl,
    revokeUrl: (url) => URL.revokeObjectURL(url),
    changed: (next) => { editorState = next; if (next.phase === "closed") onclose(); },
    saved: publishImageCrop,
  });
  onMount(() => { void session.open(sourcePath, sourceName); });
  onDestroy(() => session.dispose());
  function close(): void { if (editorState.phase !== "saving") session.close(); }
  function commitPosition(input: HTMLInputElement, edge: CropEdge): void {
    session.edge(edge, input.valueAsNumber);
    // Intermediate text belongs to the native input until blur or Enter.
    // Restore invalid input and normalize clamped coordinates at that boundary.
    if (session.state.rect) input.value = String(session.state.rect[edge]);
  }
  const edges: readonly CropEdge[] = ["left", "top", "right", "bottom"];
</script>

<Modal open={true} onClose={close} canClose={() => editorState.phase !== "saving"} label="Crop image" overlayClass="image-crop-overlay" closeOnBackdrop={false} closeOnEscape={editorState.phase !== "saving"}>
  <div class="modal-card crop-editor" aria-busy={busy}>
    <div class="dialog-header">
      <h2>Crop image</h2>
      <p class="dialog-subtitle" title={sourcePath}>{sourceName} {editorState.capture ? `· ${editorState.capture.format}` : ""}</p>
    </div>
    {#if editorState.phase === "loading"}
      <p role="status">Loading original image…</p>
    {:else if editorState.url}
      <ImageCropCanvas url={editorState.url} name={sourceName} size={editorState.size} rect={editorState.rect} disabled={busy || confirmReplace}
        onload={session.loaded} onerror={session.failedPreview} onedge={session.edge} />
    {/if}
    {#if editorState.rect && editorState.size}
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
        <button class="btn" disabled={busy || confirmReplace} onclick={session.reset}>Reset</button>
      </div>
      {#if editorState.capture?.format === "ICNS"}
        <p class="crop-note">ICNS retains each original icon size. The selected region is centered with transparent padding; largest output canvas: {editorState.size.width} × {editorState.size.height} px.</p>
      {/if}
    {/if}
    {#if editorState.error}<p class="error-message" role="alert">{editorState.error}</p>{/if}
    {#if confirmReplace}
      <div class="crop-confirm" role="group" aria-label="Confirm replacement">
        <p>Replace <strong>{sourceName}</strong> with this crop? This changes the original image.</p>
        <div class="crop-actions">
          <button class="btn" disabled={busy} data-autofocus onclick={() => confirmReplace = false}>Keep editing</button>
          <button class="btn danger" disabled={busy} onclick={() => { void session.save({ kind: "replace" }); }}>Confirm replacement</button>
        </div>
      </div>
    {:else}
      <label class="crop-copy-name">Copy filename
        <input bind:value={copyName} disabled={busy} spellcheck="false" />
      </label>
      <div class="crop-actions">
        <button class="btn" disabled={editorState.phase === "saving"} onclick={close}>Cancel</button>
        <button class="btn" disabled={busy || !editorState.rect || !editorState.capture} onclick={() => confirmReplace = true}>Replace original…</button>
        <button class="btn primary" disabled={busy || !editorState.rect || !editorState.capture || !copyName.trim()}
          onclick={() => { void session.save({ kind: "copy", name: copyName }); }}>Save copy</button>
      </div>
    {/if}
    {#if editorState.phase === "saving"}<p class="crop-note" role="status">Saving crop…</p>{/if}
  </div>
</Modal>

<style>
  /* Fixed surfaces cancel root zoom to use the physical viewport. Restore
     the user's zoom on the card, and bound its CSS size before that scale. */
  :global(.image-crop-overlay) { zoom: calc(1 / var(--app-zoom, 1)); }
  .crop-editor { zoom: var(--app-zoom, 1); width: min(920px, calc(100vw / var(--app-zoom, 1) - 32px)); min-width: 0; max-width: none; max-height: calc(100vh / var(--app-zoom, 1) - 32px); overflow: auto; display: flex; flex-direction: column; gap: var(--spacing-md); }
  .crop-editor .dialog-header { margin-bottom: 0; }
  .crop-editor { background: var(--background-solid); backdrop-filter: none; }
  .dialog-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crop-dimensions { display: flex; align-items: end; flex-wrap: wrap; gap: var(--spacing-md); }
  label { display: flex; flex-direction: column; gap: var(--spacing-xs); font-size: var(--font-size-caption); }
  input { padding: var(--spacing-sm); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; }
  input:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .crop-dimensions input { width: 6em; }
  .crop-output { margin: auto 0; color: var(--text-secondary); }
  .crop-note { color: var(--text-secondary); font-size: var(--font-size-caption); margin: 0; }
  .crop-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--spacing-sm); }
  .crop-confirm { border: 1px solid var(--control-stroke); padding: var(--spacing-md); border-radius: var(--radius-sm); }
  .crop-confirm p { margin: 0 0 var(--spacing-md); }
  @media (max-width: 480px) { .crop-editor { padding: var(--spacing-md); } }
</style>
