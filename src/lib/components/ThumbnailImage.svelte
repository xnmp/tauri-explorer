<!--
  ThumbnailImage component - Lazy-loaded image thumbnail
  Issue: tauri-explorer-im3m, tauri-1rzt
-->
<script lang="ts">
  import { getThumbnailData } from "$lib/api/files";

  interface Props {
    path: string;
    size?: number;
    fallbackColor?: string;
  }

  let { path, size = 128, fallbackColor = "#0078d4" }: Props = $props();

  let thumbnailUrl = $state<string | null>(null);
  let loading = $state(false);
  let error = $state(false);
  let visible = $state(false);
  let containerEl: HTMLDivElement | undefined = $state();

  // Use IntersectionObserver to only load when visible
  $effect(() => {
    if (!containerEl) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          visible = true;
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(containerEl);
    return () => observer.disconnect();
  });

  // Load thumbnail when visible and path changes
  $effect(() => {
    if (visible && path) {
      loadThumbnail();
    }
  });

  async function loadThumbnail() {
    loading = true;
    error = false;
    thumbnailUrl = null;

    const result = await getThumbnailData(path, size);

    if (result.ok) {
      thumbnailUrl = result.data;
    } else {
      error = true;
    }

    loading = false;
  }
</script>

<div class="thumbnail-container" style="--size: {size}px" bind:this={containerEl}>
  {#if loading || !visible}
    <!-- Show file type icon as placeholder while thumbnail loads -->
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" class="thumbnail-placeholder">
      <rect x="6" y="6" width="36" height="36" rx="4" fill={fallbackColor} fill-opacity="0.1"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke={fallbackColor} stroke-width="1.5" stroke-opacity="0.3"/>
      <circle cx="16" cy="16" r="4" fill={fallbackColor} fill-opacity="0.3"/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill={fallbackColor} fill-opacity="0.2"/>
    </svg>
    {#if loading}
      <div class="loading-overlay"><div class="spinner"></div></div>
    {/if}
  {:else if error || !thumbnailUrl}
    <!-- Fallback to image icon SVG -->
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" class="thumbnail-fallback">
      <rect x="6" y="6" width="36" height="36" rx="4" fill={fallbackColor} fill-opacity="0.15"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke={fallbackColor} stroke-width="2"/>
      <circle cx="16" cy="16" r="4" fill={fallbackColor}/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill={fallbackColor} fill-opacity="0.4"/>
    </svg>
  {:else}
    <img
      src={thumbnailUrl}
      alt=""
      class="thumbnail-image"
      width={size}
      height={size}
    />
  {/if}
</div>

<style>
  .thumbnail-container {
    width: var(--size);
    height: var(--size);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: var(--radius-sm, 4px);
    background: var(--subtle-fill-secondary, rgba(0, 0, 0, 0.03));
    position: relative;
  }

  .thumbnail-placeholder {
    opacity: 0.6;
  }

  .loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--divider, #e0e0e0);
    border-top-color: var(--accent, #0078d4);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .thumbnail-fallback {
    opacity: 0.8;
  }

  .thumbnail-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
</style>
