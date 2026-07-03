<!--
  FolderThumbnail — Windows-Explorer-style folder preview tile (issue #146).

  Composites the theme-colored folder glyph with up to MAX_PREVIEW_IMAGES
  photos "tucked into the folder pocket": back panel behind, photos in the
  middle, front flap over their bottom edge. Compositing is pure CSS/SVG on
  the client; the photo bitmaps come from the normal per-image thumbnail
  pipeline (ThumbnailImage), sharing its cache and concurrency pools.

  Freshness: the preview refetches when the folder entry's `modified` value
  changes (listing refresh), and a per-folder fs watch — registered only
  while the tile is near the viewport — refetches on `directory-changed` for
  this folder so previews update even when the *parent* watcher can't see the
  change (the backend watcher is non-recursive). The backend fingerprint
  short-circuits re-renders when the image set is unchanged.
-->
<script lang="ts">
  import { getFolderPreview, watchDirectory, unwatchDirectory } from "$lib/api/files";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { onMount, type Snippet } from "svelte";
  import ThumbnailImage from "./ThumbnailImage.svelte";

  interface Props {
    path: string;
    /** Folder mtime from the listing — a changed value re-checks the preview. */
    modified?: string;
    /** Tile display size in px (CSS container dimensions). */
    size?: number;
    /** Backend generation size for the photo thumbnails. */
    genSize?: number;
    quality?: number;
    /** Rendered while the folder has no eligible images (the plain folder
     *  icon). The component stays mounted in that state so its watch keeps
     *  running — a folder gaining its FIRST image still updates live. */
    children?: Snippet;
  }

  let { path, modified, size = 128, genSize, quality, children }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let visible = $state(false);
  let imagePaths = $state<string[]>([]);
  let fingerprint: string | null = null;

  // Defer BOTH the preview fetch and the per-folder watch to tiles near the
  // viewport, so a directory with thousands of subfolders doesn't trigger
  // thousands of scans and fs watches. Tracked both ways (not latched), same
  // rationale as ThumbnailImage.
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

  const fetchKey = $derived(`${path}:${modified ?? ""}`);
  let loadedFor: string | null = null; // last fetchKey resolved — no scroll-wiggle refetches
  let seq = 0; // stale-response guard

  async function refresh(): Promise<void> {
    const mySeq = ++seq;
    const key = fetchKey;
    const result = await getFolderPreview(path);
    if (mySeq !== seq) return; // superseded by a newer request
    loadedFor = key;
    if (!result.ok) {
      imagePaths = [];
      return;
    }
    if (result.data.fingerprint === fingerprint) return; // unchanged preview
    fingerprint = result.data.fingerprint;
    imagePaths = [...result.data.image_paths];
  }

  // Fetch when a not-yet-loaded (path, modified) combination becomes visible.
  $effect(() => {
    if (!visible || fetchKey === loadedFor) return;
    refresh();
  });

  // Watch the folder itself while visible: the backend watcher is
  // non-recursive, so changes *inside* this folder are invisible to the
  // parent directory's watch. watch/unwatch are refcounted backend-side.
  $effect(() => {
    if (!visible) return;
    const watched = path;
    watchDirectory(watched);
    return () => {
      unwatchDirectory(watched);
    };
  });

  onMount(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    listen<{ path: string }>("directory-changed", (event) => {
      if (event.payload.path === path) refresh();
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        /* browser/mock mode has no event bridge */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  // Photo geometry (fractions of the tile): a square front photo centred in
  // the pocket, with up to two photos fanned behind it. Sizes are kept close
  // so the front photo frames — rather than hides — the back pair.
  const frontSize = $derived(Math.round(size * 0.5));
  const backSize = $derived(Math.round(size * 0.46));
</script>

<div class="folder-thumb" bind:this={containerEl} style="--size: {size}px">
  {#if imagePaths.length === 0}
    {@render children?.()}
  {:else}
    <svg class="folder-layer" viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <!-- Folder back: tab (top-left) + body. Shares FileIcon's folder-large
           silhouette so a preview folder is the exact same size as a plain
           one; theme colour slightly darkened for the panel behind the photos. -->
      <path d="M2 14C2 11.79 3.79 10 6 10H14.34C15.4 10 16.42 10.42 17.17 11.17L20 14H42C44.21 14 46 15.79 46 18V37C46 39.21 44.21 41 42 41H6C3.79 41 2 39.21 2 37V14Z" class="folder-back-fill"/>
    </svg>
    {#if imagePaths[1]}
      <div class="photo back-photo left" style="width: {backSize}px; height: {backSize}px">
        <ThumbnailImage path={imagePaths[1]} size={backSize} {genSize} {quality} />
      </div>
    {/if}
    {#if imagePaths[2]}
      <div class="photo back-photo right" style="width: {backSize}px; height: {backSize}px">
        <ThumbnailImage path={imagePaths[2]} size={backSize} {genSize} {quality} />
      </div>
    {/if}
    <div class="photo front-photo" style="width: {frontSize}px; height: {frontSize}px">
      <ThumbnailImage path={imagePaths[0]} size={frontSize} {genSize} {quality} />
    </div>
    <svg class="folder-layer" viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <!-- Front flap (theme colour) covering the photos' lower edge so they read
           as tucked into the folder pocket. Matches FileIcon's front-panel
           width and rounded bottom; lowered lip (y27) leaves the pocket open. -->
      <path d="M2 27H46V39C46 40.66 44.66 42 43 42H5C3.34 42 2 40.66 2 39V27Z" class="folder-front-fill"/>
      <path d="M2 27H46V28.5H2V27Z" fill="#fff" fill-opacity="0.35"/>
    </svg>
  {/if}
</div>

<style>
  .folder-thumb {
    position: relative;
    width: var(--size);
    height: var(--size);
    /* Centres the imageless FileIcon fallback like a bare .tile-icon child. */
    display: flex;
    align-items: center;
    justify-content: center;
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

  .photo {
    position: absolute;
    border-radius: 2px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  .front-photo {
    /* Front photo sitting in the pocket: its top edge peeks just above the
       folder back (top at y14/48 ≈ 29%) while its bottom edge tucks behind the
       front flap (lip at y27/48 ≈ 56%). Narrow enough that the fanned back
       pair stays visible on either side. */
    top: 25%;
    left: 50%;
    transform: translateX(-50%);
  }

  .back-photo {
    /* Fanned higher and wider than the front photo so their upper outer
       corners peek out; lower edge tucks behind the same flap lip. */
    top: 20%;
    opacity: 0.95;
  }

  .back-photo.left {
    left: 7%;
    transform: rotate(-8deg);
  }

  .back-photo.right {
    right: 7%;
    transform: rotate(8deg);
  }
</style>
