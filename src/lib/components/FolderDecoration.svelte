<svelte:options namespace="svg" />
<script lang="ts">
  import type { FileEntry } from '$lib/domain/file';
  import { getFolderDecoration } from '$lib/domain/file-icon-identity';
  let {entry,size,arrowColor='var(--icon-link-arrow, #fff)'}: {entry:FileEntry;size:'small'|'large';arrowColor?:string}=$props();
  const decoration=$derived(getFolderDecoration(entry));
</script>

{#if decoration === 'linked'}
  {#if size === 'small'}
<path d="M7 12L11 8M11 8H8M11 8V11" stroke={arrowColor} stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  {:else}
<path d="M18 34L30 22M30 22H21M30 22V31" stroke={arrowColor} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  {/if}
{:else if decoration === 'repository'}
  {#if size === 'small'}
<circle class="git-repo-badge" cx="13.1" cy="13.1" r="3.55" fill="var(--icon-git-badge, #f05033)"/>
        <path class="git-repo-badge-ring" d="M16.15 13.1a3.05 3.05 0 1 1-6.1 0 3.05 3.05 0 0 1 6.1 0Z" fill="none" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="0.55" opacity="0.32"/>
        <g class="git-repo-badge-glyph" transform="translate(10.35 9.95) scale(0.37)">
          <circle cx="4" cy="3.5" r="1.6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" />
          <circle cx="4" cy="12.5" r="1.6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" />
          <circle cx="11.5" cy="3.5" r="1.6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" />
          <path d="M4 5.1V10.9M11.5 5.1V6.5C11.5 8.2 10 9 8 9H6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" stroke-linecap="round" />
        </g>
  {:else}
<circle class="git-repo-badge" cx="37.5" cy="37.5" r="9.25" fill="var(--icon-git-badge, #f05033)"/>
        <path class="git-repo-badge-ring" d="M45.7 37.5a8.2 8.2 0 1 1-16.4 0 8.2 8.2 0 0 1 16.4 0Z" fill="none" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.35" opacity="0.32"/>
        <g class="git-repo-badge-glyph" transform="translate(30.95 29.45) scale(0.9)">
          <circle cx="4" cy="3.5" r="1.6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" />
          <circle cx="4" cy="12.5" r="1.6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" />
          <circle cx="11.5" cy="3.5" r="1.6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" />
          <path d="M4 5.1V10.9M11.5 5.1V6.5C11.5 8.2 10 9 8 9H6" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width="1.5" stroke-linecap="round" />
        </g>
  {/if}
{/if}
