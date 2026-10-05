<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";

  let { entries }: { entries: FileEntry[] } = $props();
</script>

{#each entries as entry (entry.path)}
  <p>{entry.name}</p>
{/each}

<style>
  p { margin: 14px; overflow-wrap: anywhere; }
</style>
