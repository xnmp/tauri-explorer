<script lang="ts">
  import type { FileEntry } from '$lib/domain/file';
  import type { IconPack } from '$lib/domain/icon-themes';
  import { getFolderDecoration } from '$lib/domain/file-icon-identity';
  import FolderDecoration from './FolderDecoration.svelte';
  let {entry,size,theme}: {entry:FileEntry;size:'small'|'large';theme:IconPack}=$props();
  const decoration=$derived(getFolderDecoration(entry));
</script>

<span class="icon-cat folder-icon" class:linked-folder={decoration==='linked'} class:git-repo-folder={decoration==='repository'} class:classic-large={theme==='classic' && size==='large'}
  data-icon-theme={theme} style:color={'var(--icon-folder, #ffb900)'}>
  <svg class:folder-large={size==='large'} width={size==='small'?16:64} height={size==='small'?16:64} viewBox={size==='small'?'0 0 18 18':'0 0 48 48'} fill="none" aria-hidden="true">
    {#if theme==='minimal'}
      {#if size==='small'}
        <path d="M3 6.5H15V13C15 13.8284 14.3284 14.5 13.5 14.5H4.5C3.67157 14.5 3 13.8284 3 13V6.5Z" stroke="currentColor" stroke-width="1.25"/>
        <path d="M3 5.5C3 4.67 3.67 4 4.5 4H7L9 6H13.5C14.33 6 15 6.67 15 7.5" stroke="currentColor" stroke-width="1.25"/>
      {:else}
        <path d="M5 15H43V40C43 42.1 41.66 43.75 40 43.75H8C6.34 43.75 5 42.1 5 40V15Z" stroke="currentColor" stroke-width="1.5"/>
        <path d="M5 10C5 7.9 6.34 6.25 8 6.25H17L21 11.25H40C41.66 11.25 43 12.9 43 15" stroke="currentColor" stroke-width="1.5"/>
      {/if}
    {:else if size==='small'}
      <path d="M2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5H14.5C15.0523 6.5 15.5 6.94772 15.5 7.5V12.5C15.5 13.6046 14.6046 14.5 13.5 14.5H4.5C3.39543 14.5 2.5 13.6046 2.5 12.5V7.5Z" fill="currentColor"/>
      <path d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L8.12132 4.29289C8.30886 4.10536 8.56321 4 8.82843 4H13C13.8284 4 14.5 4.67157 14.5 5.5V6.5H2V5.5Z" fill="currentColor" opacity="0.6"/>
    {:else}
      <path d="M2 10C2 7.2 3.79 5 6 5H14.34C15.4 5 16.42 5.5 17.17 6.5L20 10H42C44.21 10 46 12.2 46 15V38.75C46 41.5 44.21 43.75 42 43.75H6C3.79 43.75 2 41.5 2 38.75V10Z" fill="currentColor" opacity="0.85"/>
      <path d="M2 20C2 17.9 3.34 16.25 5 16.25H43C44.66 16.25 46 17.9 46 20V41.25C46 43.3 44.66 45 43 45H5C3.34 45 2 43.3 2 41.25V20Z" fill="currentColor"/>
      {#if theme==='classic'}<path d="M2 20C2 17.9 3.34 16.25 5 16.25H43C44.66 16.25 46 17.9 46 20V21.25H2V20Z" fill="#fff" opacity="0.25"/>{/if}
    {/if}
    <FolderDecoration {entry} {size} arrowColor={theme==='minimal'?'var(--icon-link-arrow, currentColor)':undefined} />
  </svg>
</span>

<style>
  .folder-icon { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; line-height:0; }
  .classic-large { filter:drop-shadow(0 2px 2px rgb(0 0 0 / .25)); }
</style>
