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
  import { getFolderPreview } from "$lib/api/thumbnails";
  import { createDirectoryWatch } from "$lib/state/directory-watch";
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
    const watch = createDirectoryWatch();
    void watch.update(path);
    return () => { void watch.destroy(); };
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
  // the pocket, with up to two photos fanned behind it. Sized to fill the
  // folder interior — the slim flap lip (y37.5/48 ≈ 78%) overlapping their
  // bottom edge is what makes them read as "inside"; sizes are kept close so
  // the front photo frames the back pair. Scaled with the taller folder
  // silhouette (#264).
  const frontSize = $derived(Math.round(size * 0.68));
  const backSize = $derived(Math.round(size * 0.6));
</script>

<div class="folder-thumb" bind:this={containerEl} style="--size: {size}px">
  {#if imagePaths.length === 0}
    {@render children?.()}
  {:else}
    <svg class="folder-layer" viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <!-- Folder back: tab (top-left) + body. Shares FileIcon's folder-large
           silhouette so a preview folder is the exact same size as a plain
           one; theme colour slightly darkened for the panel behind the photos. -->
      <path d="M2 10C2 7.2 3.79 5 6 5H14.34C15.4 5 16.42 5.5 17.17 6.5L20 10H42C44.21 10 46 12.2 46 15V38.75C46 41.5 44.21 43.75 42 43.75H6C3.79 43.75 2 41.5 2 38.75V10Z" class="folder-back-fill"/>
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
           width and rounded bottom; slim lip (y36) keeps nearly the whole
           interior open so the photos can fill the folder. -->
      <path d="M2 37.5H46V41.25C46 43.3 44.66 45 43 45H5C3.34 45 2 43.3 2 41.25V37.5Z" class="folder-front-fill"/>
      <path d="M2 37.5H46V39H2V37.5Z" fill="#fff" fill-opacity="0.35"/>
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
    /* Front photo filling the pocket: top edge just below the folder back's
       mouth (y10/48 ≈ 21%) so the folder silhouette stays readable, bottom
       edge tucked behind the front flap (lip at y37.5/48 ≈ 78%). Narrow
       enough that the fanned back pair stays visible on either side. */
    top: 21%;
    left: 50%;
    transform: translateX(-50%);
  }

  .back-photo {
    /* Fanned wider than the front photo so their rotated edges peek out at
       the sides; kept inside the pocket like the front photo. */
    top: 25%;
    opacity: 0.95;
  }

  .back-photo.left {
    left: 6%;
    transform: rotate(-6deg);
  }

  .back-photo.right {
    right: 6%;
    transform: rotate(6deg);
  }
</style>
