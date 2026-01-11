<!--
  FileItem component - displays a single file or directory entry.
  Issue: tauri-explorer-iw0
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { formatSize } from "$lib/domain/file";

  interface Props {
    entry: FileEntry;
    onclick: () => void;
  }

  let { entry, onclick }: Props = $props();
</script>

<button class="file-item" class:directory={entry.kind === "directory"} {onclick}>
  <span class="icon">{entry.kind === "directory" ? "📁" : "📄"}</span>
  <span class="name">{entry.name}</span>
  <span class="size">{formatSize(entry.size)}</span>
</button>

<style>
  .file-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border: none;
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: inherit;
    font-size: 14px;
    color: var(--text-primary, #1a1a1a);
  }

  .file-item:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.04));
  }

  .file-item:focus {
    outline: 2px solid var(--focus-ring, #0078d4);
    outline-offset: -2px;
  }

  .icon {
    flex-shrink: 0;
    font-size: 16px;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    color: var(--text-secondary, #666);
    font-size: 12px;
    min-width: 60px;
    text-align: right;
  }
</style>
