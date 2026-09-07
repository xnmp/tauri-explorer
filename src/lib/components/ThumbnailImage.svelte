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
  import { getMicroThumbnail, getThumbnailData, getVideoThumbnailData } from "$lib/api/thumbnails";

  // Dual concurrency pools: micro is fast (small payload), full is heavier.
  // The pools are the cancellation seam (#136): queued work re-checks
  // visibility when its slot frees, so a fast scroll-past doesn't decode every
  // tile it crossed. Keep requests per-item — batching them into one IPC call
  // was measured in #593 to make scroll pacing WORSE (responses arrive as one
  // clump that blocks the main thread) even though it improves throughput.
  // The backend additionally bounds decode concurrency globally (decode gate
  // in thumbnails.rs), so pool width here is about response pacing, not CPU.
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
  import { untrack } from "svelte";
  import { getThumbnailCache, setThumbnailCache } from "$lib/state/thumbnail-cache";

  /**
   * "image"  — progressive micro+full image thumbnail (default).
   * "video"  — single ffmpeg frame-extraction thumbnail.
   * Video is a single-shot fetch with no micro pre-warm; on error the parent
   * renders its own fallback icon (we set `error` and emit nothing).
   */
  type ThumbnailKind = "image" | "video";

  interface Props {
    path: string;
    /** What to generate: image (default) or video frame */
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

  // Track viewport membership BOTH ways (no disconnect-on-first-intersect):
  // a fast scroll through a large folder intersects every tile once, and a
  // latched `visible` would queue thumbnail work for all of them. Leaving the
  // viewport lets queued work bail (see the acquire guards below); re-entering
  // re-triggers the load effect.
  $effect(() => {
    if (!containerEl) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
      },
      { rootMargin: "200px" }
    );

    observer.observe(containerEl);
    return () => observer.disconnect();
  });

  // Reload key: changes when path, kind, size, or quality changes
  const reloadKey = $derived(`${kind}:${path}:${backendSize}:${quality}`);

  // Load-state bookkeeping so visibility toggles don't duplicate work:
  // a key is loaded (terminal: success or error), in flight, or neither.
  let loadedKey: string | null = null;
  let inflightKey: string | null = null;

  // Hydrate synchronously from the shared LRU cache at mount: remounts
  // (virtual-list rechunk, fullscreen-preview exit, duplicating a tab) must
  // paint the cached thumbnail on their FIRST frame instead of flashing the
  // placeholder while waiting for the IntersectionObserver's initial tick
  // (#247, #248). The cache is invalidated on file change/rename by
  // thumbnail-cache.ts, so a hit is always current.
  {
    // untrack: reading the initial prop values here is intentional — later
    // changes go through the reloadKey load effect.
    const initialKey = untrack(() => `${kind}:${path}:${backendSize}:${quality}`);
    const cached = getThumbnailCache(initialKey);
    if (cached?.full) {
      microUrl = cached.micro;
      fullUrl = cached.full;
      // Cache hits skip the micro→full cross-fade: the full image is already
      // in memory, and waiting for onload + 150ms fade shows the pixelated
      // micro layer on every remount (#259).
      fullLoaded = true;
      loadedKey = initialKey;
    }
  }

  // Load thumbnails when visible, unless this key is already loaded/loading
  $effect(() => {
    if (!visible || reloadKey === loadedKey || reloadKey === inflightKey) return;
    if (kind === "image") {
      loadProgressiveThumbnail();
    } else {
      loadSingleThumbnail();
    }
  });

  // Video thumbnails are single-shot (no micro pre-warm). On failure we notify
  // the parent so it can fall back to its own file-type icon.
  async function loadSingleThumbnail() {
    const currentPath = path;
    const currentKey = reloadKey;
    inflightKey = currentKey;

    try {
      const cached = getThumbnailCache(currentKey);
      if (cached?.full) {
        microUrl = null;
        fullUrl = cached.full;
        fullLoaded = true; // cache hit — no cross-fade (#259)
        loading = false;
        error = false;
        loadedKey = currentKey;
        return;
      }

      loading = true;
      error = false;
      microUrl = null;
      fullUrl = null;
      fullLoaded = false;

      await fullPool.acquire();
      try {
        // Scrolled out of view (or props changed) while queued — skip the
        // fetch; the load effect retries if the tile comes back into view.
        if (currentKey !== reloadKey || !visible) return;

        const result = await getVideoThumbnailData(currentPath, backendSize, quality);
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
        loadedKey = currentKey; // terminal either way — don't retry on scroll wiggle
      } finally {
        fullPool.release();
      }
    } finally {
      if (inflightKey === currentKey) inflightKey = null;
      if (currentKey === reloadKey) loading = false;
    }
  }

  async function loadProgressiveThumbnail() {
    const currentPath = path;
    // Stale-response guard compares the FULL reload key (path + size + quality):
    // comparing only path lets a slow old-size response win over a newer size.
    const currentKey = reloadKey;
    inflightKey = currentKey;

    try {
      // Check frontend cache (survives renames without backend re-generation)
      const cached = getThumbnailCache(currentKey);
      if (cached?.full) {
        microUrl = cached.micro;
        fullUrl = cached.full;
        fullLoaded = true; // cache hit — no cross-fade (#259)
        loading = false;
        error = false;
        loadedKey = currentKey;
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
        // Scrolled out of view (or props changed) while queued — skip the
        // fetch; the load effect retries if the tile comes back into view.
        if (currentKey !== reloadKey || !visible) return;

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
        if (currentKey !== reloadKey || (!visible && !microUrl)) return;

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

      if (currentKey === reloadKey && (fullUrl || microUrl || error)) {
        loadedKey = currentKey; // terminal — error included, no scroll-wiggle retries
        if (fullUrl || microUrl) {
          setThumbnailCache(currentKey, { micro: microUrl, full: fullUrl });
        }
      }
    } finally {
      if (inflightKey === currentKey) inflightKey = null;
      if (currentKey === reloadKey) loading = false;
    }
  }
</script>

<div class="thumbnail-container" style="--size: {size}px" bind:this={containerEl}>
  {#if (!microUrl && !fullUrl && !error) || (loading && !microUrl)}
    <!-- Placeholder only while nothing is loaded yet — a loaded thumbnail
         stays visible through IntersectionObserver flickers (layout shifts,
         fullscreen-preview exit) instead of flashing back to the SVG (#247).
         No loading spinner on purpose (#593): an animated overlay per loading
         tile forces WebKitGTK into per-frame software rasterization across
         the whole grid during a cold scroll — measured to halve the frame
         rate. The static placeholder communicates "loading" well enough for
         the ~100-300ms a micro thumbnail takes. -->
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" class="thumbnail-placeholder">
      <rect x="6" y="6" width="36" height="36" rx="4" fill={fallbackColor} fill-opacity="0.1"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke={fallbackColor} stroke-width="1.5" stroke-opacity="0.3"/>
      <circle cx="16" cy="16" r="4" fill={fallbackColor} fill-opacity="0.3"/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill={fallbackColor} fill-opacity="0.2"/>
    </svg>
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
        decoding="async"
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
        decoding="async"
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

</style>
