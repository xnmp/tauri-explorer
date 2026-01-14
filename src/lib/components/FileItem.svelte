<!--
  FileItem component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { formatSize } from "$lib/domain/file";
  import { explorer } from "$lib/state/explorer.svelte";

  interface Props {
    entry: FileEntry;
    onclick: (event: MouseEvent) => void;
    ondblclick: () => void;
    selected?: boolean;
  }

  let { entry, onclick, ondblclick, selected = false }: Props = $props();

  function handleClick(event: MouseEvent) {
    onclick(event);
  }

  // Check if this item is in clipboard (for visual feedback)
  const isInClipboard = $derived(
    explorer.state.clipboard?.entry.path === entry.path
  );
  const isCut = $derived(
    isInClipboard && explorer.state.clipboard?.operation === "cut"
  );

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  function handleKeydown(event: KeyboardEvent) {
    const hasModifier = event.ctrlKey || event.metaKey;

    const keyActions: Record<string, () => void> = {
      Delete: () => explorer.startDelete(entry),
      F2: () => explorer.startRename(entry),
    };

    const modifierKeyActions: Record<string, () => void> = {
      c: () => explorer.copyToClipboard(entry),
      x: () => explorer.cutToClipboard(entry),
    };

    const action = keyActions[event.key] ?? (hasModifier ? modifierKeyActions[event.key] : undefined);

    if (action) {
      event.preventDefault();
      action();
    }
  }

  // Format modified date
  function formatDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return date.toLocaleDateString(undefined, { weekday: "short" });
    } else {
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  }
</script>

<button
  class="file-item"
  class:directory={entry.kind === "directory"}
  class:cut={isCut}
  class:in-clipboard={isInClipboard}
  class:selected
  onclick={handleClick}
  {ondblclick}
  oncontextmenu={handleContextMenu}
  onkeydown={handleKeydown}
>
  <!-- Name column -->
  <div class="name-cell">
    <div class="icon" aria-hidden="true">
      {#if entry.kind === "directory"}
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L7.5 4.91421L8.12132 4.29289C8.30886 4.10536 8.56321 4 8.82843 4H13C13.8284 4 14.5 4.67157 14.5 5.5V6H15.5V5.5C15.5 4.11929 14.3807 3 13 3H8.82843C8.29799 3 7.78929 3.21071 7.41421 3.58579L7.5 3.67157L7.58579 3.58579C7.21071 3.21071 6.70201 3 6.17157 3H3.5C2.11929 3 1 4.11929 1 5.5V12.5C1 13.8807 2.11929 15 3.5 15H8V14H3.5C2.67157 14 2 13.3284 2 12.5V5.5Z"
            fill="currentColor"
            class="folder-back"
          />
          <path
            d="M2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5H14.5C15.0523 6.5 15.5 6.94772 15.5 7.5V12.5C15.5 13.6046 14.6046 14.5 13.5 14.5H4.5C3.39543 14.5 2.5 13.6046 2.5 12.5V7.5Z"
            fill="currentColor"
            class="folder-front"
          />
        </svg>
      {:else}
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z"
            fill="currentColor"
            class="file-body"
          />
          <path
            d="M10 2V6C10 6.55228 10.4477 7 11 7H15L10 2Z"
            fill="currentColor"
            class="file-corner"
          />
        </svg>
      {/if}
    </div>
    <span class="name">{entry.name}</span>
    {#if isInClipboard}
      <div class="clipboard-badge" aria-label={isCut ? "Cut" : "Copied"}>
        {#if isCut}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 2L1.5 3.5L3 5M7 2L8.5 3.5L7 5M2 3.5H8" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2.5 2.5H7.5M2.5 2.5V7.5C2.5 7.77614 2.72386 8 3 8H7C7.27614 8 7.5 7.77614 7.5 7.5V2.5M2.5 2.5L3 1.5H7L7.5 2.5M4.5 4.5V6M5.5 4.5V6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Date modified column -->
  <div class="date-cell">
    {formatDate(entry.modified)}
  </div>

  <!-- Type column -->
  <div class="type-cell">
    {entry.kind === "directory" ? "File folder" : "File"}
  </div>

  <!-- Size column -->
  <div class="size-cell">
    {#if entry.kind === "file"}
      {formatSize(entry.size)}
    {:else}
      <span class="empty-cell">—</span>
    {/if}
  </div>
</button>

<style>
  .file-item {
    display: grid;
    grid-template-columns: 1fr 180px 160px 100px;
    gap: 8px;
    align-items: center;
    padding: 4px 16px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: inherit;
    color: var(--text-primary);
    transition: all var(--transition-fast);
    position: relative;
    min-height: 32px;
  }

  .file-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .file-item:active {
    background: var(--subtle-fill-tertiary);
  }

  .file-item:focus-visible {
    outline: none;
    border-color: var(--accent);
    background: var(--subtle-fill-secondary);
    box-shadow: 0 0 0 1px var(--accent);
  }

  /* Selected state */
  .file-item.selected {
    background: var(--subtle-fill-secondary);
    border-color: var(--accent);
  }

  .file-item.selected:hover {
    background: var(--subtle-fill-tertiary);
  }

  /* Cut items appear faded */
  .file-item.cut {
    opacity: 0.5;
  }

  .file-item.in-clipboard:not(.cut) {
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.06), rgba(0, 120, 212, 0.02));
    border-color: rgba(0, 120, 212, 0.2);
  }

  /* Name cell */
  .name-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  /* Icon container */
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  /* Folder colors */
  .folder-back {
    opacity: 0.6;
  }

  .folder-front {
    opacity: 0.9;
  }

  .directory .icon {
    color: #f9d86e;
  }

  /* File colors */
  .file-body {
    opacity: 0.15;
  }

  .file-corner {
    opacity: 0.25;
  }

  .file-item:not(.directory) .icon {
    color: var(--text-secondary);
  }

  /* Name */
  .name {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  /* Date, Type, Size cells */
  .date-cell,
  .type-cell,
  .size-cell {
    font-size: 13px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size-cell {
    text-align: right;
    padding-right: 8px;
  }

  .empty-cell {
    opacity: 0.3;
  }

  /* Clipboard badge */
  .clipboard-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: var(--accent);
    color: var(--text-on-accent);
    border-radius: 3px;
    flex-shrink: 0;
  }

  .file-item.cut .clipboard-badge {
    background: var(--system-caution);
  }

  /* Dark mode folder color adjustment */
  @media (prefers-color-scheme: dark) {
    .directory .icon {
      color: #f7d56c;
    }

    .file-item:not(.directory) .icon {
      color: var(--text-tertiary);
    }

    .file-body {
      opacity: 0.12;
    }

    .file-corner {
      opacity: 0.2;
    }
  }
</style>
