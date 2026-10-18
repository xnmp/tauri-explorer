<!-- Artwork derived from the approved imagegen direction; canonical SVGs live in icons/material/. -->
<script lang="ts">
  import type { FileEntry } from '$lib/domain/file';
  import { resolveFileIcon } from '$lib/domain/file-icon-identity';
  import { getFileExtensionLabel } from '$lib/domain/file-types';
  import spriteUrl from './icons/material-sprite.svg?url';

  let {entry,size}: {entry:FileEntry;size:'small'|'large'}=$props();
  const descriptor=$derived(resolveFileIcon(entry));
  const icon=$derived(descriptor.identity==='folder'?'file':descriptor.identity);
  const label=$derived(icon==='file' && size==='large' ? getFileExtensionLabel(entry) : '');
  const tint=$derived(`var(--icon-file-tint, var(--icon-${descriptor.category}))`);
</script>

<span class="icon-cat material-file-icon" class:icon-html={icon==='html'} class:icon-video={icon==='video'} role={icon==='video'?'img':undefined} aria-label={icon==='video'?'Video':undefined}
  data-icon-theme="material" data-icon-id={icon} style:--icon-pack-tint={tint}>
  <svg width={size==='small'?16:64} height={size==='small'?16:64} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <use href={`${spriteUrl}#${label?'file-label':icon}`} width="48" height="48" />
    {#if label}<text x="24" y="34" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size={label.length<=3?12:9} fill="#fff">{label}</text>{/if}
  </svg>
</span>

<style>
  .material-file-icon { display:inline-flex; align-items:center; justify-content:center; line-height:0; flex-shrink:0; }
</style>
