<!--
  ThumbnailImage component - Two-tier progressive thumbnail loading
  Issue: tauri-explorer-im3m, tauri-1rzt, tauri-nag1, tauri-e2mn

  Loading flow:
  1. SVG placeholder (not visible yet)
  2. IntersectionObserver fires → request micro thumbnail (16x16, pixelated)
  3. Micro thumbnail appears instantly → request full thumbnail (cache hit from pre-warm)
  4. Full thumbnail cross-fades in over 150ms
-->
<script lang="ts" module>
  import { getMicroThumbnail, getThumbnailData } from "$lib/api/files";

  // Dual concurrency pools: micro is fast (small payload), full is heavier
  function createPool(max: number) {
    let active = 0;
    const queue: Array<() => void> = [];

    return {
      acquire(): Promise<void> {
        if (active < max) {
          active++;
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          queue.push(() => {
            active++;
            resolve();
          });
        });
      },
      release(): void {
        active--;
        const next = queue.shift();
        if (next) next();
      },
    };
  }

  const microPool = createPool(8);
  const fullPool = createPool(4);
</script>

<script lang="ts">
  interface Props {
    path: string;
    size?: number;
    fallbackColor?: string;
  }

  let { path, size = 128, fallbackColor = "#0078d4" }: Props = $props();

  let microUrl = $state<string | null>(null);
  let fullUrl = $state<string | null>(null);
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

  // Load thumbnails when visible and path changes
  $effect(() => {
    if (visible && path) {
      loadProgressiveThumbnail();
    }
  });

  async function loadProgressiveThumbnail() {
    const currentPath = path;
    loading = true;
    error = false;
    microUrl = null;
    fullUrl = null;

    // Stage 1: micro thumbnail (fast, pixelated preview)
    await microPool.acquire();
    try {
      // Bail if path changed while queued
      if (currentPath !== path) return;

      const microResult = await getMicroThumbnail(currentPath);
      if (currentPath !== path) return;

      if (microResult.ok) {
        microUrl = microResult.data;
      }
    } finally {
      microPool.release();
    }

    // Stage 2: full thumbnail (should be a cache hit from micro's pre-warm)
    await fullPool.acquire();
    try {
      if (currentPath !== path) return;

      const fullResult = await getThumbnailData(currentPath, size);
      if (currentPath !== path) return;

      if (fullResult.ok) {
        fullUrl = fullResult.data;
      } else if (!microUrl) {
        error = true;
      }
    } finally {
      fullPool.release();
    }

    if (currentPath === path) {
      loading = false;
    }
  }
</script>

<div class="thumbnail-container" style="--size: {size}px" bind:this={containerEl}>
  {#if !visible || (loading && !microUrl)}
    <!-- SVG placeholder while waiting for first thumbnail -->
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" class="thumbnail-placeholder">
      <rect x="6" y="6" width="36" height="36" rx="4" fill={fallbackColor} fill-opacity="0.1"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke={fallbackColor} stroke-width="1.5" stroke-opacity="0.3"/>
      <circle cx="16" cy="16" r="4" fill={fallbackColor} fill-opacity="0.3"/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill={fallbackColor} fill-opacity="0.2"/>
    </svg>
    {#if loading}
      <div class="loading-overlay"><div class="spinner"></div></div>
    {/if}
  {:else if error && !microUrl}
    <!-- Fallback to image icon SVG -->
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" class="thumbnail-fallback">
      <rect x="6" y="6" width="36" height="36" rx="4" fill={fallbackColor} fill-opacity="0.15"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke={fallbackColor} stroke-width="2"/>
      <circle cx="16" cy="16" r="4" fill={fallbackColor}/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill={fallbackColor} fill-opacity="0.4"/>
    </svg>
  {:else}
    <!-- Two-layer thumbnail: micro (pixelated) underneath, full on top -->
    {#if microUrl}
      <img
        src={microUrl}
        alt=""
        class="thumbnail-micro"
        width={size}
        height={size}
      />
    {/if}
    {#if fullUrl}
      <img
        src={fullUrl}
        alt=""
        class="thumbnail-full"
        class:loaded={true}
        width={size}
        height={size}
      />
    {/if}
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

  .thumbnail-micro {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
    image-rendering: pixelated;
    image-rendering: -moz-crisp-edges;
    filter: blur(1px);
  }

  .thumbnail-full {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
    opacity: 0;
    transition: opacity 150ms ease;
  }

  .thumbnail-full.loaded {
    opacity: 1;
  }
</style>
