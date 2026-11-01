<svelte:options namespace="svg" />
<script lang="ts">
  import type { FileEntry } from '$lib/domain/file';
  import { getFolderDecoration, repositoryEmblem, type RepositoryEmblemSurface } from '$lib/domain/file-icon-identity';
  // `size` picks the viewBox geometry (18 or 48 units); `rendered` is the
  // drawn size for surfaces whose 48-unit overlay is shown at 16px.
  let {entry,size,surface='folder',rendered=size,arrowColor='var(--icon-link-arrow, #fff)'}: {entry:FileEntry;size:'small'|'large';surface?:RepositoryEmblemSurface;rendered?:'small'|'large';arrowColor?:string}=$props();
  const decoration=$derived(getFolderDecoration(entry));
  const emblem=$derived(repositoryEmblem(surface, surface==='folder' ? size : rendered));
  const side=$derived(emblem.r*Math.SQRT2);
</script>

{#if decoration === 'linked'}
  {#if size === 'small'}
<path d="M7 12L11 8M11 8H8M11 8V11" stroke={arrowColor} stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  {:else}
<path d="M18 34L30 22M30 22H21M30 22V31" stroke={arrowColor} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  {/if}
{:else if decoration === 'repository'}
<!-- Git emblem on the folder body (#1477): a themed diamond plate with an
     original branch glyph, clear of the corner where peek carets sit. -->
<g class="git-repo-emblem">
  <rect class="git-repo-emblem-plate" x={emblem.cx-side/2} y={emblem.cy-side/2} width={side} height={side} rx={side*0.2}
    transform="rotate(45 {emblem.cx} {emblem.cy})" fill="var(--icon-git-badge, #f05033)"/>
  <g class="git-repo-emblem-glyph" transform="translate({emblem.cx} {emblem.cy}) scale({emblem.r/10})" stroke="var(--icon-git-badge-glyph, #fff)" stroke-width={emblem.stroke} stroke-linecap="round" fill="none">
    <path d="M-2.4-3.4V3.4M2.8-1.4C2.8 1.4-2.4.6-2.4 2.8"/>
    <circle cx="-2.4" cy="-3.6" r="1.3" fill="var(--icon-git-badge-glyph, #fff)"/>
    <circle cx="-2.4" cy="3.6" r="1.3" fill="var(--icon-git-badge-glyph, #fff)"/>
    <circle cx="2.8" cy="-1.6" r="1.3" fill="var(--icon-git-badge-glyph, #fff)"/>
  </g>
</g>
{/if}
