<script lang="ts">
  import type { PeekGroup } from "$lib/domain/folder-peek";
  import { layoutStore } from "$lib/state/layout.svelte";
  let { groups, row, carets = true }: { groups: readonly PeekGroup[]; row: number; carets?: boolean } = $props();
  // Under the caret, or (no carets) under the parent's folder icon centre.
  const base = $derived(carets ? 30 : 26);
  // Details rows follow the layout theme's row height (#1306).
  const rowHeight = $derived(layoutStore.detailsRowHeight);
</script>

{#each groups.filter(group => group.startRow <= row && row < group.endRow) as group (group.path)}
  {@const height = (group.endRow - group.startRow) * rowHeight}
  <span class="peek-guide" aria-hidden="true" style:left={`${base + group.depth * 22}px`}
    style:background-image={`linear-gradient(to bottom, var(--accent), var(--divider) ${Math.min(64, height * .6)}px)`}
    style:background-size={`100% ${height}px`} style:background-position={`0 -${(row - group.startRow) * rowHeight}px`}></span>
{/each}

<style>
  .peek-guide { position: absolute; top: 0; bottom: 0; width: 1.5px; pointer-events: none; }
</style>
