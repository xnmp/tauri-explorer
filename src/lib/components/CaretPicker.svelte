<!--
  CaretPicker - Subdirectory dropdown shown when clicking a breadcrumb separator.
  Fetches child directories of the given parent and lets the user navigate into one.
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { fetchDirectory } from "$lib/api/files";

  interface Props {
    parentPath: string;
    anchorEl: HTMLElement;
    onNavigate: (path: string) => void;
    onClose: () => void;
  }

  let { parentPath, anchorEl, onNavigate, onClose }: Props = $props();

  let dirs = $state<FileEntry[]>([]);

  // Fetch subdirectories on mount / when parentPath changes
  $effect(() => {
    const path = parentPath;
    dirs = [];
    fetchDirectory(path).then((result) => {
      if (result.ok) {
        dirs = result.data.entries.filter((e) => e.kind === "directory");
      }
    });
  });

  function select(path: string): void {
    onNavigate(path);
  }

  const left = $derived(anchorEl.getBoundingClientRect().left);
  const top = $derived(anchorEl.getBoundingClientRect().bottom + 4);
</script>

{#if dirs.length > 0}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="caret-picker-backdrop" onclick={(e) => { e.stopPropagation(); onClose(); }} onkeydown={(e) => { if (e.key === "Escape") onClose(); }}></div>
  <div class="caret-picker" style="left: {left}px; top: {top}px;">
    {#each dirs as dir (dir.path)}
      <button class="caret-picker-item" onclick={() => select(dir.path)}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 3.5C3 2.67 3.67 2 4.5 2H7L8.5 3.5H12.5C13.33 3.5 14 4.17 14 5V12C14 12.83 13.33 13.5 12.5 13.5H4.5C3.67 13.5 3 12.83 3 12V3.5Z" fill="var(--icon-folder, #ffb900)" opacity="0.8"/>
        </svg>
        {dir.name}
      </button>
    {/each}
  </div>
{/if}

<style>
  .caret-picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .caret-picker {
    position: fixed;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout, 0 4px 16px rgba(0, 0, 0, 0.15));
    max-height: 300px;
    min-width: 180px;
    overflow-y: auto;
    z-index: 100;
    padding: 4px;
  }

  .caret-picker-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .caret-picker-item:hover {
    background: var(--subtle-fill-secondary);
  }
</style>
