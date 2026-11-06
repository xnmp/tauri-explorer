import type { Component } from 'svelte';

/** The large built-in file artwork variants, in FileIcon's precedence. */
export type LargeFileArtKind = 'image' | 'archive' | 'lang' | 'code' | 'media' | 'executable' | 'document';
export type LargeFileArtProps = { kind: LargeFileArtKind; label: string; fontSize: number; color?: string };

let lazy = $state.raw<Component<LargeFileArtProps>>();
let loading: Promise<unknown> | undefined;

/**
 * Startup seam for the large (Tiles) built-in file artwork (#1532). The
 * artwork draws each glyph twice — a static shadow copy, then the glyph —
 * instead of a per-frame CSS `filter: drop-shadow`, and the startup bundle
 * has no room for that. Every view renderer is lazy, so the Tiles renderers
 * await this chunk with their own import (view-loaders) and render it in the
 * same flush; any other large surface starts the import on first use and
 * picks the renderer up reactively.
 */
export function loadLargeFileArt(): Promise<unknown> {
  loading ??= import('./LargeFileArt.svelte').then(
    (m) => { lazy = m.default; },
    (error) => { loading = undefined; throw error; },
  );
  return loading;
}

/** The loaded renderer, or undefined until its chunk settles. Reactive. */
export function largeFileArt(): Component<LargeFileArtProps> | undefined {
  if (!lazy) loadLargeFileArt().catch(() => {});
  return lazy;
}
