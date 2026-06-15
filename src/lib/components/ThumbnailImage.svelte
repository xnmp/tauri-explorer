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
  import {
    getMicroThumbnail,
    getThumbnailData,
    getVideoThumbnailData,
    getFolderThumbnailData,
  } from "$lib/api/files";

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
  import { getThumbnailCache, setThumbnailCache } from "$lib/state/thumbnail-cache";

  /**
   * "image"  — progressive micro+full image thumbnail (default).
   * "video"  — single ffmpeg frame-extraction thumbnail.
   * "folder" — single 2x2 collage of the folder's images.
   * Video and folder are single-shot fetches with no micro pre-warm; on error
   * the parent renders its own fallback icon (we set `error` and emit nothing).
   */
  type ThumbnailKind = "image" | "video" | "folder";

  interface Props {
    path: string;
    /** What to generate: image (default), video frame, or folder collage */
    kind?: ThumbnailKind;
    /** Display size in px (CSS container dimensions) */
    size?: number;
    /** Backend generation size in px (defaults to size if not set) */
    genSize?: number;
    quality?: number;
    fallbackColor?: string;
    /** Called when generation fails (e.g. no ffmpeg / no images) so the parent
     *  can render its own icon instead of the broken-image fallback. */
    onunavailable?: () => void;
  }

  let {
    path,
    kind = "image",
    size = 128,
    genSize,
    quality,
    fallbackColor = "#0078d4",
    onunavailable,
  }: Props = $props();

  const backendSize = $derived(genSize ?? size);

  let microUrl = $state<string | null>(null);
  let fullUrl = $state<string | null>(null);
  // Set when the full <img> has actually decoded — drives the 150ms cross-fade
  let fullLoaded = $state(false);
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

  // Reload key: changes when path, kind, size, or quality changes
  const reloadKey = $derived(`${kind}:${path}:${backendSize}:${quality}`);

  // Load thumbnails when visible and reload key changes
  $effect(() => {
    if (visible && reloadKey) {
      if (kind === "image") {
        loadProgressiveThumbnail();
      } else {
        loadSingleThumbnail();
      }
    }
  });

  // Video/folder thumbnails are single-shot (no micro pre-warm). On failure we
  // notify the parent so it can fall back to its own file-type / folder icon.
  async function loadSingleThumbnail() {
    const currentPath = path;
    const currentKey = reloadKey;

    const cached = getThumbnailCache(currentKey);
    if (cached?.full) {
      microUrl = null;
      fullUrl = cached.full;
      loading = false;
      error = false;
      return;
    }

    loading = true;
    error = false;
    microUrl = null;
    fullUrl = null;
    fullLoaded = false;

    await fullPool.acquire();
    try {
      if (currentKey !== reloadKey) return;

      const result =
        kind === "video"
          ? await getVideoThumbnailData(currentPath, backendSize, quality)
          : await getFolderThumbnailData(currentPath, backendSize, quality);
      if (currentKey !== reloadKey) return;

      if (result.ok) {
        fullUrl = result.data;
        setThumbnailCache(currentKey, { micro: null, full: fullUrl });
      } else {
        // Diagnostic: surfaces backend reasons (e.g. "ffmpeg not found",
        // "no album art") in the dev console so missing thumbnails are explainable.
        console.warn(`[thumbnail] ${kind} thumbnail unavailable for ${currentPath}: ${result.error}`);
        error = true;
        onunavailable?.();
      }
    } finally {
      fullPool.release();
      if (currentKey === reloadKey) loading = false;
    }
  }

  async function loadProgressiveThumbnail() {
    const currentPath = path;
    // Stale-response guard compares the FULL reload key (path + size + quality):
    // comparing only path lets a slow old-size response win over a newer size.
    const currentKey = reloadKey;

    // Check frontend cache (survives renames without backend re-generation)
    const cached = getThumbnailCache(currentKey);
    if (cached?.full) {
      microUrl = cached.micro;
      fullUrl = cached.full;
      loading = false;
      error = false;
      return;
    }

    loading = true;
    error = false;
    microUrl = null;
    fullUrl = null;
    fullLoaded = false;

    // Stage 1: micro thumbnail (fast, pixelated preview)
    await microPool.acquire();
    try {
      if (currentKey !== reloadKey) return;

      const microResult = await getMicroThumbnail(currentPath, backendSize, quality);
      if (currentKey !== reloadKey) return;

      if (microResult.ok) {
        microUrl = microResult.data;
      }
    } finally {
      microPool.release();
    }

    // Stage 2: full thumbnail (should be a cache hit from micro's pre-warm)
    await fullPool.acquire();
    try {
      if (currentKey !== reloadKey) return;

      const fullResult = await getThumbnailData(currentPath, backendSize, quality);
      if (currentKey !== reloadKey) return;

      if (fullResult.ok) {
        fullUrl = fullResult.data;
      } else if (!microUrl) {
        error = true;
      }
    } finally {
      fullPool.release();
    }

    if (currentKey === reloadKey) {
      loading = false;
      if (fullUrl || microUrl) {
        setThumbnailCache(currentKey, { micro: microUrl, full: fullUrl });
      }
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
  {:else if kind === "folder" && fullUrl}
    <!-- Folder thumbnail (Windows Explorer-style): a yellow folder with the photo
         tucked into the front pocket, peeking above the front flap. Back panel +
         tab behind the photo, lighter front flap over the photo's bottom. -->
    <div class="folder-thumb">
      <svg class="folder-layer" viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <!-- Folder back: tab (top-left) + body, theme colour slightly darkened. -->
        <path d="M3 13C3 11.9 3.9 11 5 11H15.5C16 11 16.5 11.2 16.9 11.6L18.5 13.2H43C44.1 13.2 45 14.1 45 15.2V38C45 39.1 44.1 40 43 40H5C3.9 40 3 39.1 3 38V13Z" class="folder-back-fill"/>
      </svg>
      <img
        src={fullUrl}
        alt=""
        class="folder-photo"
        class:loaded={fullLoaded}
        onload={() => { fullLoaded = true; }}
        draggable="false"
      />
      <svg class="folder-layer" viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <!-- Front flap (theme colour) covering the photo's lower edge so it reads
             as tucked into the folder pocket. -->
        <path d="M3 30H45V38C45 39.1 44.1 40 43 40H5C3.9 40 3 39.1 3 38V30Z" class="folder-front-fill"/>
        <path d="M3 30H45V31.5H3V30Z" fill="#fff" fill-opacity="0.35"/>
      </svg>
    </div>
  {:else}
    <!-- Two-layer thumbnail: micro (pixelated) underneath, full on top -->
    {#if microUrl}
      <img
        src={microUrl}
        alt=""
        class="thumbnail-micro"
        width={size}
        height={size}
        draggable="false"
      />
    {/if}
    {#if fullUrl}
      <img
        src={fullUrl}
        alt=""
        class="thumbnail-full"
        class:loaded={fullLoaded}
        onload={() => { fullLoaded = true; }}
        width={size}
        height={size}
        draggable="false"
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
    contain: strict;
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

  /* Folder thumbnail: photo tucked inside a folder shape */
  .folder-thumb {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .folder-layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /* Folder colour follows the active theme (--icon-folder), with a darker back
     panel and the base colour on the front flap. */
  .folder-back-fill {
    fill: color-mix(in srgb, var(--icon-folder, #e8a800) 82%, #000);
  }

  .folder-front-fill {
    fill: var(--icon-folder, #e8a800);
  }

  .folder-photo {
    position: absolute;
    /* Large, prominent photo sitting in the folder: it spans most of the tile,
       its bottom edge (~78%) tucked behind the front flap (front top at y30 ≈
       63%), with the gold folder framing it and the tab peeking top-left. */
    top: 17%;
    left: 11%;
    right: 11%;
    bottom: 22%;
    width: auto;
    height: auto;
    object-fit: cover;
    border-radius: 2px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    opacity: 0;
    transition: opacity 150ms ease;
  }

  .folder-photo.loaded {
    opacity: 1;
  }
</style>
