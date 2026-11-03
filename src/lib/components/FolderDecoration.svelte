<svelte:options namespace="svg" />
<script lang="ts">
  import type { FileEntry } from '$lib/domain/file';
  import { getFolderDecoration, repositoryEmblem, repositoryGlyphPath, type RepositoryEmblemSurface, type RepositoryFolderStyle } from '$lib/domain/file-icon-identity';
  // `size` picks the viewBox geometry (18 or 48 units); `rendered` is the
  // drawn size for surfaces whose 48-unit overlay is shown at 16px.
  let {entry,size,surface='folder',rendered=size,repoStyle='filled',arrowColor='var(--icon-link-arrow, #fff)'}: {entry:FileEntry;size:'small'|'large';surface?:RepositoryEmblemSurface;rendered?:'small'|'large';repoStyle?:RepositoryFolderStyle;arrowColor?:string}=$props();
  const decoration=$derived(getFolderDecoration(entry));
  const e=$derived(repositoryEmblem(surface, surface==='folder' ? size : rendered, repoStyle));
  // Filled folders take the Git colour, so the glyph is knocked out in the
  // window background; outline folders stroke it in their own tint (#1490).
  const ink=$derived(repoStyle==='filled' ? 'var(--icon-git-badge-glyph, var(--background-solid, #fff))' : 'var(--icon-git-badge, #f05033)');
  const fill=$derived(e.ring ? 'none' : ink);
</script>

{#if decoration === 'linked'}
  {#if size === 'small'}
<path d="M7 12L11 8M11 8H8M11 8V11" stroke={arrowColor} stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  {:else}
<path d="M18 34L30 22M30 22H21M30 22V31" stroke={arrowColor} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  {/if}
{:else if decoration === 'repository'}
<!-- Branch glyph on the Git-tinted folder body (#1490), clear of the corner
     where peek carets sit (#1477); nodes at REPOSITORY_GLYPH_NODES. -->
<g class="git-repo-emblem" transform="translate({e.cx} {e.cy}) scale({e.unit}) rotate({e.rotate})"
  stroke={ink} stroke-width={e.stroke/e.unit} fill="none">
  <path d={repositoryGlyphPath(e)}/>
  <circle cx="-4" cy="-6" r={e.r} {fill}/>
  <circle cx="-4" cy="6" r={e.r} {fill}/>
  <circle cx="4" cy="-3" r={e.r} {fill}/>
</g>
{/if}
