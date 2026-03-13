<!--
  ListView - Compact multi-column list view with CSS grid column-flow.
  Issue: tauri-explorer-9djf.5
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { getDropSourcePath, handleFileDrop } from "$lib/state/drop-operations";
  import { useInlineRename } from "$lib/composables/use-inline-rename.svelte";
  import { getFileIconColor } from "$lib/domain/file-types";
  import FileIcon from "./FileIcon.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    contentWidth: number;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
  }

  let { explorer, contentWidth, onitemclick, onitemdblclick }: Props = $props();

  const paneNav = getPaneNavigationContext();

  // Compute effective list column count (auto or fixed)
  const effectiveListColumns = $derived.by(() => {
    if (settingsStore.listViewColumns > 0) return settingsStore.listViewColumns;
    if (contentWidth <= 0) return 1;
    return Math.max(1, Math.min(6, Math.floor(contentWidth / settingsStore.listColumnMaxWidth)));
  });

  // Inline rename composable
  const rename = useInlineRename(() => explorer);

  const renamingEntry = $derived(dialogStore.renamingEntry);

  $effect(() => {
    if (renamingEntry && rename.renameInputRef) {
      rename.focusAndSelect(renamingEntry);
    }
  });

  // Per-entry drop target state
  let dropTargets = $state<Record<string, boolean>>({});
  let copyDropTargets = $state<Record<string, boolean>>({});

  function handleItemDragEnd(): void {
    dragState.clear();
    paneNav?.refreshAllPanes();
  }

  function handleItemDragStart(event: DragEvent, entry: FileEntry): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData("application/x-explorer-path", entry.path);
    event.dataTransfer.setData("application/x-explorer-name", entry.name);
    event.dataTransfer.setData("application/x-explorer-kind", entry.kind);
    event.dataTransfer.effectAllowed = "all";
    dragState.start({ path: entry.path, name: entry.name, kind: entry.kind });
  }

  function handleItemDragOver(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    if (!event.dataTransfer?.types.includes("application/x-explorer-path") && !dragState.readCrossWindow()) return;
    event.preventDefault();
    const copying = event.ctrlKey;
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    dropTargets[entry.path] = true;
    copyDropTargets[entry.path] = copying;
  }

  function handleItemDragLeave(entry: FileEntry): void {
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;
  }

  async function handleItemDrop(event: DragEvent, entry: FileEntry): Promise<void> {
    event.preventDefault();
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;
    if (entry.kind !== "directory" || !event.dataTransfer) return;

    const sourcePath = getDropSourcePath(event.dataTransfer);
    if (!sourcePath || sourcePath === entry.path) return;
    if (entry.path.startsWith(sourcePath + "/")) return;

    await handleFileDrop(sourcePath, entry.path, event.ctrlKey, {
      onRefresh: () => paneNav?.refreshAllPanes(),
    });
  }

  const totalItems = $derived(explorer.displayEntries.length + (explorer.isCreatingFolder ? 1 : 0));
  const listRows = $derived(Math.ceil(totalItems / effectiveListColumns));

  function isInClipboard(entry: FileEntry): boolean {
    return clipboardStore.content?.entries.some((e) => e.path === entry.path) ?? false;
  }

  function isCut(entry: FileEntry): boolean {
    return isInClipboard(entry) && clipboardStore.isCut;
  }

  function handleItemContextMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault();
    event.stopPropagation();
    if (!explorer.isSelected(entry)) {
      explorer.selectEntry(entry, {});
    }
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }
</script>

<div class="list-view file-rows" style="--list-columns: {effectiveListColumns}; --list-rows: {listRows};">
  {#if explorer.isCreatingFolder}
    <InlineNewFolder {explorer} variant="list" />
  {/if}
  {#each explorer.displayEntries as entry (entry.path)}
    <button
      class="list-item entry-item"
      class:directory={entry.kind === "directory"}
      class:selected={explorer.isSelected(entry)}
      class:cut={isCut(entry)}
      class:in-clipboard={isInClipboard(entry)}
      class:drop-target={dropTargets[entry.path]}
      class:copy-drop={copyDropTargets[entry.path]}
      draggable="true"
      onclick={(e) => onitemclick(entry, e)}
      ondblclick={() => onitemdblclick(entry)}
      oncontextmenu={(e) => handleItemContextMenu(e, entry)}
      ondragstart={(e) => handleItemDragStart(e, entry)}
      ondragend={handleItemDragEnd}
      ondragover={(e) => handleItemDragOver(e, entry)}
      ondragleave={() => handleItemDragLeave(entry)}
      ondrop={(e) => handleItemDrop(e, entry)}
    >
      <span class="list-icon" style:color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined}>
        <FileIcon {entry} size="small" />
      </span>
      {#if renamingEntry?.path === entry.path}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          class="rename-input"
          class:error={!!rename.renameError}
          bind:value={rename.editedName}
          bind:this={rename.renameInputRef}
          onkeydown={(e) => rename.handleRenameKeydown(e, entry.name)}
          onblur={() => rename.handleRenameBlur(entry.name)}
          onclick={(e) => e.stopPropagation()}
          disabled={rename.submittingRename}
          autofocus
        />
      {:else}
        <span class="list-name entry-name">{entry.name}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .list-view {
    display: grid;
    grid-template-rows: repeat(var(--list-rows, 1), auto);
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 4px;
    padding: 8px;
    overflow-y: auto;
    flex: 1;
    align-content: start;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-left-width: var(--selection-indicator-width);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    transition: background var(--transition-fast);
  }

  .list-item:focus {
    outline: none;
  }

  .list-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .list-item.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
  }

  .list-item.cut {
    opacity: 0.5;
  }

  .list-item.in-clipboard:not(.cut) {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }

  .list-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .list-item.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
  }

  .list-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .list-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Inline rename input */
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    background: var(--control-fill);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: var(--font-size-body);
    color: var(--text-primary);
    outline: none;
  }

  .rename-input.error {
    border-color: var(--system-critical);
  }
</style>
