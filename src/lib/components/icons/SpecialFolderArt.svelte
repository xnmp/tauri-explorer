<svelte:options namespace="svg" />
<!--
  Special folder artwork (#1491), lazily loaded through
  special-folder-icons.svelte.ts and mounted inside FolderIcon's or
  CatppuccinFileIcon's <svg>. Variant selection and badge geometry live in
  domain/special-folders. The host's folder is never repainted: the kind is a
  bottom-left corner badge on top of it (#1527).
-->
<script module lang="ts">
  // Re-exported so by-name folder surfaces (#1499) share this lazy chunk.
  export { specialFolderIconEntry } from '$lib/domain/special-folders';
</script>

<script lang="ts">
  import { CATPPUCCIN_GLYPH_CROP, resolveSpecialFolderVariant } from '$lib/domain/special-folders';
  import type { SpecialFolderArtProps } from './special-folder-icons.svelte';
  import glyphSprite from './folder-glyphs-sprite.svg?url';

  let { entry, size, theme, sprite }: SpecialFolderArtProps = $props();
  const v = $derived(resolveSpecialFolderVariant(entry, theme, size));
  const href = $derived(v && `${v.sprite === 'catppuccin' ? sprite : glyphSprite}#${v.symbol}`);
</script>

{#if v}
  {@const b = v.box}
  {@const g = b.glyph}
  <!-- CatppuccinFileIcon recomputes its palette on .special-folder-art, keeping the glyph's own accent. -->
  <g class="special-folder-art special-folder-badge" data-special-folder={v.kind}>
    <rect class="special-folder-badge-backing" x={b.x} y={b.y} width={b.w} height={b.w} rx={b.rx} fill={v.fill} stroke={v.outline} stroke-width={b.ring} />
    {#if v.sprite === 'catppuccin'}
      <svg x={g.x} y={g.y} width={g.w} height={g.w} viewBox={CATPPUCCIN_GLYPH_CROP} overflow="hidden">
        <use class="special-folder-glyph" {href} width="16" height="16" stroke-width={v.stroke} />
      </svg>
    {:else}
      <use class="special-folder-glyph" {href} x={g.x} y={g.y} width={g.w} height={g.w} stroke-width={v.stroke} style:color={v.ink} />
    {/if}
  </g>
{/if}
