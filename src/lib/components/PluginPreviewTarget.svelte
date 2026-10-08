<!--
  Preview of a plugin target (SDK 2): a non-file subject such as an unsaved
  generated image or an outside reference. It shows the target's image,
  details and explicit actions only — no file actions, opening, sibling
  stepping or dragging, because it is not an Explorer file.
-->
<script lang="ts">
  import { getThumbnailData } from "$lib/api/thumbnails";
  import type { PreviewTarget, PreviewTargetAction } from "$lib/plugins/preview-registry.svelte";
  import type { Snippet } from "svelte";

  interface Props {
    target: PreviewTarget;
    showInfo: boolean;
    sections?: Snippet;
  }

  let { target, showInfo, sections }: Props = $props();
  let imageUrl = $state<string | null>(null);
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
  {#if imageUrl}
    <img src={imageUrl} alt={target.title} class="preview-image" draggable="false" />
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
  .preview-content { position: relative; flex: 1; overflow: auto; display: flex; flex-direction: column; min-height: 0; padding: 12px; }
  .preview-image { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: var(--radius-sm); box-shadow: var(--shadow-card); }
  .preview-loading { display: flex; align-items: center; justify-content: center; flex: 1; padding: 24px; }
  .spinner { width: 20px; height: 20px; border: 1.5px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: target-spin 600ms linear infinite; }
  @keyframes target-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .preview-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 10px; color: var(--text-tertiary); font-size: var(--font-size-caption); }
  .preview-info { display: flex; flex-direction: column; border-top: 1px solid var(--divider); flex-shrink: 0; }
  .info-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: var(--font-size-caption); padding: 8px var(--preview-info-inset); border-bottom: 1px solid var(--divider); }
  .info-label { color: var(--text-tertiary); flex-shrink: 0; }
  .info-value { color: var(--text-secondary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .target-content { display: flex; align-items: center; justify-content: center; }
  .target-content .preview-image { max-width: 100%; max-height: 100%; object-fit: contain; }
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
