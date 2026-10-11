<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  let { entry, renaming = false }: { entry: FileEntry; renaming?: boolean } = $props();
</script>

{#if entry.is_symlink && !renaming && entry.kind !== "directory"}
  <div class="symlink-badge" title={entry.symlink_target ? `Link to ${entry.symlink_target}` : "Symbolic link"}>
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M7 3L3 7M3 3L3 7L7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
{/if}

<style>
  .symlink-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--text-tertiary);
    flex-shrink: 0;
    opacity: 0.7;
  }
</style>
