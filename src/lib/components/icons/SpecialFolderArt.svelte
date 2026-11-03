<svelte:options namespace="svg" />
<!--
  Special folder artwork (#1491), lazily loaded through
  special-folder-icons.svelte.ts and mounted inside FolderIcon's or
  CatppuccinFileIcon's <svg>. Variant selection lives in domain/special-folders.
  Paint that replaces the host's own folder (Material's recoloured body,
  Catppuccin's small composite) carries a class the host's CSS uses to hide
  the plain folder underneath.
-->
<script module lang="ts">
  // Re-exported so by-name folder surfaces (#1499) share this lazy chunk.
  export { specialFolderIconEntry } from '$lib/domain/special-folders';
</script>

<script lang="ts">
  import { resolveSpecialFolderVariant } from '$lib/domain/special-folders';
  import type { SpecialFolderArtProps } from './special-folder-icons.svelte';
  import glyphSprite from './folder-glyphs-sprite.svg?url';

  let { entry, size, theme, sprite }: SpecialFolderArtProps = $props();
  const v = $derived(resolveSpecialFolderVariant(entry, theme, size));
  const href = $derived(v && `${v.sprite === 'catppuccin' ? sprite : glyphSprite}#${v.symbol}`);
</script>

{#if v}
  <g class="special-folder-art" data-special-folder={v.kind}>
    {#if v.sprite === 'catppuccin'}
      <!-- CatppuccinFileIcon recomputes its palette on .special-folder-art, keeping the glyph's own accent. -->
      <use class={v.overlay ? 'special-folder-glyph' : 'special-folder-composite'} {href} x={v.x} y={v.y} width={v.w} height={v.w} />
    {:else}
      {#if v.body}
        <!-- Material colours the folder per kind: FolderIcon's body geometry, repainted. -->
        <g class="special-folder-body" style:color={v.body}>
          {#if size === 'small'}
            <path d="M2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5H14.5C15.0523 6.5 15.5 6.94772 15.5 7.5V12.5C15.5 13.6046 14.6046 14.5 13.5 14.5H4.5C3.39543 14.5 2.5 13.6046 2.5 12.5V7.5Z" fill="currentColor"/>
            <path d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L8.12132 4.29289C8.30886 4.10536 8.56321 4 8.82843 4H13C13.8284 4 14.5 4.67157 14.5 5.5V6.5H2V5.5Z" fill="currentColor" opacity="0.6"/>
          {:else}
            <path d="M2 10C2 7.2 3.79 5 6 5H14.34C15.4 5 16.42 5.5 17.17 6.5L20 10H42C44.21 10 46 12.2 46 15V38.75C46 41.5 44.21 43.75 42 43.75H6C3.79 43.75 2 41.5 2 38.75V10Z" fill="currentColor" opacity="0.85"/>
            <path d="M2 20C2 17.9 3.34 16.25 5 16.25H43C44.66 16.25 46 17.9 46 20V41.25C46 43.3 44.66 45 43 45H5C3.34 45 2 43.3 2 41.25V20Z" fill="currentColor"/>
          {/if}
        </g>
      {/if}
      <use class="special-folder-glyph" {href} x={v.x} y={v.y} width={v.w} height={v.w} stroke-width={v.stroke} style:color={v.ink} />
    {/if}
  </g>
{/if}
