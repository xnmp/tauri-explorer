<!--
  Folder-list preview: the children of a previewed directory or ZIP archive,
  with an indicator when the preview descended through single-child folders.
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { getFileIconColor } from "$lib/domain/file-types";
  import FileIcon from "./FileIcon.svelte";

  interface Props {
    entries: readonly FileEntry[];
    /** Collapsed single-child path (e.g. "a/b") the preview descended into. */
    collapsedRoot: string | null;
    collapsedNote: string | null;
  }

  let { entries, collapsedRoot, collapsedNote }: Props = $props();
</script>

<div class="preview-folder-list">
  {#if collapsedRoot}
    <div class="collapsed-root-indicator" title="Showing the contents of the only folder inside">
      <svg class="collapsed-root-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 4C2 3.45 2.45 3 3 3H6L7.5 4.5H13C13.55 4.5 14 4.95 14 5.5V12C14 12.55 13.55 13 13 13H3C2.45 13 2 12.55 2 12V4Z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="1.1"/>
      </svg>
      <span class="collapsed-root-name">{collapsedRoot}/</span>
      <span class="collapsed-root-note">{collapsedNote}</span>
    </div>
  {/if}
  {#each entries as child}
    <div class="folder-item" class:is-directory={child.kind === "directory"}>
      <span class="folder-item-icon" style:color={child.kind !== "directory" ? getFileIconColor(child) : undefined}>
        <FileIcon entry={child} size="small" />
      </span>
      <span class="folder-item-name">{child.name}</span>
    </div>
  {/each}
</div>

<style>
  .preview-folder-list {
    flex: 1;
    overflow: auto;
    padding: 4px 0;
  }

  .collapsed-root-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 8px 6px;
    padding: 5px 8px;
    background: var(--subtle-fill-secondary);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .collapsed-root-icon {
    color: var(--accent-text, var(--accent));
    flex-shrink: 0;
  }

  .collapsed-root-name {
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collapsed-root-note {
    margin-left: auto;
    color: var(--text-tertiary);
    font-size: 11px;
    flex-shrink: 0;
  }

  .folder-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .folder-item.is-directory .folder-item-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .folder-item-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .folder-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
