<script lang="ts">
  import type { PeekGroup } from "$lib/domain/folder-peek";
  let { groups, row }: { groups: readonly PeekGroup[]; row: number } = $props();
</script>

{#each groups.filter(group => group.startRow <= row && row < group.endRow) as group (group.path)}
  {@const height = (group.endRow - group.startRow) * 32}
  <span class="peek-guide" aria-hidden="true" style:left={`${30 + group.depth * 22}px`}
    style:background-image={`linear-gradient(to bottom, var(--accent), var(--divider) ${Math.min(64, height * .6)}px)`}
    style:background-size={`100% ${height}px`} style:background-position={`0 -${(row - group.startRow) * 32}px`}></span>
{/each}

<style>
  .peek-guide { position: absolute; top: 0; bottom: 0; width: 1.5px; pointer-events: none; }
</style>
