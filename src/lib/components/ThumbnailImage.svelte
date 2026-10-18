<!--
  ThumbnailImage component - Two-tier progressive thumbnail loading
  Issue: tauri-explorer-im3m, tauri-1rzt, tauri-nag1, tauri-e2mn

  Loading flow:
  1. SVG placeholder (not visible yet)
  2. IntersectionObserver fires → request micro thumbnail (16x16, pixelated)
  3. Micro thumbnail appears instantly → request full thumbnail (cache hit from pre-warm)
  4. Full thumbnail cross-fades in over 150ms

  The loads themselves, their concurrency pools and their publication to the
  shared cache live in state/thumbnail-loads.ts: this tile only watches the load
  for its key while it is mounted and on screen.
-->
<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { getMicroThumbnail, getThumbnailData, getVideoThumbnailData } from "$lib/api/thumbnails";
  import { getThumbnailCache, subscribeThumbnailInvalidation } from "$lib/state/thumbnail-cache";
  import { thumbnailLoads, type ThumbnailRequests, type ThumbnailState } from "$lib/state/thumbnail-loads";

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
    /** File-view fallback follows its selected icon pack while thumbnails load/fail. */
    fallback?: Snippet;
  }

  let {
    path,
    kind = "image",
    size = 128,
    genSize,
    quality,
    fallbackColor = "#0078d4",
    onunavailable,
    fallback,
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
  // viewport stops watching, so queued work bails; re-entering watches again.
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

  // The key whose load settled here (success or error): visibility toggles
  // never retry it, and a loaded thumbnail stays through them (#247).
  let loadedKey: string | null = null;
  // Bumped when this path's cached thumbnails were invalidated (a crop): the
  // key is unchanged, so the load effect needs another reason to run again.
  let reloadNonce = $state(0);
  $effect(() => subscribeThumbnailInvalidation(changed => {
    if (changed !== path) return;
    loadedKey = null;
    reloadNonce++;
  }));

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

  /** Show a load's state. Only a watching (so mounted) tile is called. */
  function show(key: string, loadKind: ThumbnailKind, loadPath: string, state: ThumbnailState) {
    if (state.full !== fullUrl) {
      fullUrl = state.full;
      fullLoaded = state.cached && state.full !== null; // cache hit — no cross-fade (#259)
    }
    microUrl = state.micro;
    loading = !state.settled;
    error = state.error !== null;
    if (!state.settled) return;
    loadedKey = key; // terminal either way — don't retry on scroll wiggle
    if (state.error !== null && loadKind === "video") {
      // Diagnostic: surfaces backend reasons (e.g. "ffmpeg not found",
      // "no album art") in the dev console so missing thumbnails are explainable.
      console.warn(`[thumbnail] ${loadKind} thumbnail unavailable for ${loadPath}: ${state.error}`);
      onunavailable?.();
    }
  }

  // Watch the load for this key while on screen, unless it already settled here.
  // Unmounting, leaving the screen or a new key unsubscribes; the load itself
  // still publishes whatever it completes to the shared cache.
  $effect(() => {
    if (!visible) return;
    void reloadNonce;
    const key = reloadKey;
    if (key === loadedKey) return;
    const loadKind = kind, loadPath = path, loadSize = backendSize, loadQuality = quality;
    const requests: ThumbnailRequests = loadKind === "image"
      ? { micro: () => getMicroThumbnail(loadPath, loadSize, loadQuality), full: () => getThumbnailData(loadPath, loadSize, loadQuality) }
      : { full: () => getVideoThumbnailData(loadPath, loadSize, loadQuality) };
    return untrack(() => thumbnailLoads.watch(key, requests, {
      visible: () => visible,
      update: state => show(key, loadKind, loadPath, state),
    }));
  });
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
    {#if fallback}
      <div class="thumbnail-placeholder pack-icon" style:--fallback-scale={size / 64}>{@render fallback()}</div>
    {:else}
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" class="thumbnail-placeholder">
      <rect x="6" y="6" width="36" height="36" rx="4" fill={fallbackColor} fill-opacity="0.1"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke={fallbackColor} stroke-width="1.5" stroke-opacity="0.3"/>
      <circle cx="16" cy="16" r="4" fill={fallbackColor} fill-opacity="0.3"/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill={fallbackColor} fill-opacity="0.2"/>
    </svg>
    {/if}
  {:else if error && !microUrl}
    <!-- Fallback to image icon SVG -->
    {#if fallback}
      <div class="thumbnail-fallback pack-icon" style:--fallback-scale={size / 64}>{@render fallback()}</div>
    {:else}
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" class="thumbnail-fallback">
      <rect x="6" y="6" width="36" height="36" rx="4" fill={fallbackColor} fill-opacity="0.15"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke={fallbackColor} stroke-width="2"/>
      <circle cx="16" cy="16" r="4" fill={fallbackColor}/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill={fallbackColor} fill-opacity="0.4"/>
    </svg>
    {/if}
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
    /* Keep presses on the stable file cell while decorative images load. */
    pointer-events: none;
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

  .pack-icon { width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
  .pack-icon :global(> *) { flex-shrink:0; transform:scale(var(--fallback-scale)); }

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
