<!-- A Details row's cells for shown plugin columns (#1523); loaded lazily.
     Values load through the row's request; empty while loading or absent. -->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import type { PluginDetailColumn } from "$lib/domain/plugin-detail-columns";
  import { detailColumnRegistry } from "$lib/plugins/detail-column-registry.svelte";

  let { entry, columns }: { entry: FileEntry; columns: readonly PluginDetailColumn[] } = $props();
</script>

{#each columns as column (column.id)}
  {@const text = detailColumnRegistry.text(entry, column)}
  <div class="plugin-cell" data-cell={column.id} title={text}>{text ?? ""}</div>
{/each}

<style>
  .plugin-cell {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
