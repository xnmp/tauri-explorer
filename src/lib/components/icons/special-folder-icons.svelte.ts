import type { Component } from 'svelte';
import type { FileEntry } from '$lib/domain/file';
import type { IconPack } from '$lib/domain/icon-themes';

export type SpecialFolderArtProps = { entry: FileEntry; size: 'small' | 'large'; theme: IconPack; sprite?: string };

let art = $state.raw<Component<SpecialFolderArtProps>>();
let loading: Promise<unknown> | undefined;

/**
 * Startup seam for special folder icons (#1491). The alias table, artwork and
 * renderer load as one lazy chunk when the first folder icon renders (the
 * startup bundle has almost no headroom); folders draw plainly until then and
 * pick the renderer up reactively.
 */
export function specialFolderArt(): Component<SpecialFolderArtProps> | undefined {
  loading ??= import('./SpecialFolderArt.svelte').then((m) => (art = m.default));
  return art;
}
