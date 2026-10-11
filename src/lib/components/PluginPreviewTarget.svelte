<!--
  Preview of a plugin target (SDK 2): a non-file subject such as an unsaved
  generated image or an outside reference. It shows the target's image,
  details and explicit actions only — no file actions, opening, sibling
  stepping or dragging, because it is not an Explorer file. Its image
  fullscreens like a file image, through the pane's fullscreen controller
  (#1033): the pane shows a 1024px thumbnail until the target first goes
  fullscreen, which loads the full-resolution image; that is then kept.
-->
<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import { getThumbnailData } from "$lib/api/thumbnails";
  import { loadPreviewImage } from "$lib/state/preview-image";
  import type { PreviewFullscreen } from "$lib/composables/use-preview-fullscreen.svelte";
  import type { PreviewTarget, PreviewTargetAction } from "$lib/plugins/preview-registry.svelte";
  import { createPreviewLifetime } from "$lib/state/preview-lifetime";
  import PreviewImageSurface from "./PreviewImageSurface.svelte";

  interface Props {
    target: PreviewTarget;
    showInfo: boolean;
    fullscreen: PreviewFullscreen;
    sections?: Snippet;
  }

  let { target, showInfo, fullscreen, sections }: Props = $props();
  let imageUrl = $state<string | null>(null);
  // The full-resolution image, loaded like a file image's (asset protocol,
  // then the backend read), so a path outside the current folder — such as a
  // plugin's temp directory — works too. Fetched the first time this target
  // goes fullscreen and then shown in the pane too; the thumbnail shows until
  // it decodes. Targets carry no version: a plugin that rewrites an image in
  // place gives the new image a new target id (the component is keyed on it).
  let fullImage = $state<{ path: string; url: string } | null>(null);
  const fullImageLifetime = createPreviewLifetime((url) => URL.revokeObjectURL(url));
  onDestroy(() => fullImageLifetime.dispose());
  const shownUrl = $derived(fullImage && fullImage.path === target.imagePath ? fullImage.url : imageUrl);
  let imageError = $state(false);
  let running = $state<string | null>(null);
  let actionError = $state("");

  $effect(() => {
    const path = target.imagePath;
    imageUrl = null;
    imageError = false;
    if (!path) return;
    let cancelled = false;
    let owned: string | null = null;
    void getThumbnailData(path, 1024).then((result) => {
      if (cancelled) { if (result.ok) URL.revokeObjectURL(result.data); return; }
      if (result.ok) { owned = result.data; imageUrl = result.data; } else imageError = true;
    });
    return () => { cancelled = true; if (owned) URL.revokeObjectURL(owned); };
  });

  $effect(() => {
    const path = target.imagePath;
    if (!fullscreen.active || !path || fullImage?.path === path) return;
    const request = fullImageLifetime.begin(path);
    void loadPreviewImage(path, target.id, {
      isCurrent: () => fullImageLifetime.isCurrent(request),
      adoptBlob: (url) => fullImageLifetime.adoptBlob(request, url),
      releaseBlob: (url) => fullImageLifetime.releaseBlob(request, url),
    }).then((image) => {
      if (image.status === "ready") fullImage = { path, url: image.url };
    });
  });

  // An action belongs to the target it was started for.
  $effect(() => { void target.id; actionError = ""; });

  async function run(action: PreviewTargetAction) {
    if (running || action.disabled) return;
    const id = target.id;
    running = action.id;
    actionError = "";
    try { await action.run(); }
    catch (error) { if (target.id === id) actionError = error instanceof Error ? error.message : String(error); }
    finally { running = null; }
  }
</script>

{#if showInfo}
  <div class="preview-header">
    <span class="preview-filename" title={target.title}>{target.title}</span>
    {#if target.typeLabel}<span class="preview-type-badge">{target.typeLabel}</span>{/if}
  </div>
{/if}

<div class="preview-content target-content" role="region" aria-label="Preview of {target.title}">
  {#if shownUrl}
    <PreviewImageSurface src={shownUrl} alt={target.title} {fullscreen} />
  {:else if target.imagePath && !imageError}
    <div class="preview-loading"><div class="spinner"></div></div>
  {:else}
    <div class="preview-empty"><span>No preview available</span></div>
  {/if}
</div>

{#if target.badge || target.actions?.length}
  <!-- One wrapper so a vertical dock can place the actions and their status
       as a single grid item (PreviewPane owns that layout). -->
  <div class="target-actions-area">
    <div class="target-actions" role="group" aria-label="Actions for {target.title}">
      {#if target.badge}<span class="target-badge">{target.badge}</span>{/if}
      {#each target.actions ?? [] as action (action.id)}
        <button type="button" class="target-action" title={action.title ?? action.label} aria-label={action.label}
          disabled={action.disabled || running !== null} onclick={() => run(action)}>
          {#if action.icon === "save"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3h13l4 4v14H4zM8 3v6h9V3M8 21v-8h9v8"/></svg>
          {:else if action.icon === "delete"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>
          {/if}
          {#if action.icon !== "delete"}<span>{action.label}</span>{/if}
        </button>
      {/each}
    </div>
    {#if running}<p class="target-status" role="status">Working…</p>{/if}
    {#if actionError}<p class="target-error" role="alert">{actionError}</p>{/if}
  </div>
{/if}

{#if showInfo}
  {#if target.details?.length}
    <div class="preview-info">
      {#each target.details as detail (detail.label)}
        <div class="info-row">
          <span class="info-label">{detail.label}</span>
          <span class="info-value" title={detail.value}>{detail.value}</span>
        </div>
      {/each}
    </div>
  {/if}
  {@render sections?.()}
{/if}

<style>
  /* Mirrors PreviewPane's file-preview chrome (scoped styles do not cross components). */
  .preview-header { display: flex; flex-direction: column; gap: 6px; padding: 16px var(--preview-info-inset) 14px; border-bottom: 1px solid var(--divider); flex-shrink: 0; }
  .preview-filename { font-size: var(--font-size-body); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview-type-badge { display: inline-flex; align-self: flex-start; font-size: 10px; line-height: 1; color: var(--accent-text, var(--accent)); background: color-mix(in srgb, var(--accent) 12%, transparent); padding: 3px 8px; border-radius: var(--radius-pill); }
  .preview-content { position: relative; flex: 1; overflow: auto; display: flex; flex-direction: column; min-height: 0; }
  .preview-loading { display: flex; align-items: center; justify-content: center; flex: 1; padding: 24px; }
  .spinner { width: 20px; height: 20px; border: 1.5px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: target-spin 600ms linear infinite; }
  @keyframes target-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .preview-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 10px; color: var(--text-tertiary); font-size: var(--font-size-caption); }
  .preview-info { display: flex; flex-direction: column; border-top: 1px solid var(--divider); flex-shrink: 0; }
  .info-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: var(--font-size-caption); padding: 8px var(--preview-info-inset); border-bottom: 1px solid var(--divider); }
  .info-label { color: var(--text-tertiary); flex-shrink: 0; }
  .info-value { color: var(--text-secondary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .target-actions-area { flex-shrink: 0; min-width: 0; }
  .target-actions { display: flex; align-items: center; gap: 6px; padding: 6px 12px; flex-wrap: wrap; }
  .target-badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; color: var(--system-caution-text, var(--text-primary)); background: color-mix(in srgb, var(--system-caution-text, #a76d24) 14%, transparent); }
  .target-action { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; font: inherit; font-size: 11px; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  .target-action:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  .target-action:disabled { opacity: .5; cursor: default; }
  .target-action:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .target-status, .target-error { margin: 0 12px 6px; font-size: 11px; color: var(--text-secondary); overflow-wrap: anywhere; }
  .target-error { color: var(--system-critical-text); }
</style>
