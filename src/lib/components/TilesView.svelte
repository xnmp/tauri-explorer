<!--
  TilesView - Grid view with thumbnails and progressive rendering.
  Issue: tauri-explorer-9djf.5
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { getDropSourcePath, handleFileDrop } from "$lib/state/drop-operations";
  import { useInlineRename } from "$lib/composables/use-inline-rename.svelte";
  import { getFileIconColor, isImageFile } from "$lib/domain/file-types";
  import FileIcon from "./FileIcon.svelte";
  import ThumbnailImage from "./ThumbnailImage.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
  }

  let { explorer, onitemclick, onitemdblclick }: Props = $props();

  const paneNav = getPaneNavigationContext();

  // Inline rename composable
  const rename = useInlineRename(() => explorer);

  const renamingEntry = $derived(dialogStore.renamingEntry);

  $effect(() => {
    if (renamingEntry && rename.renameInputRef) {
      rename.focusAndSelect(renamingEntry);
    }
  });

  // Progressive rendering to avoid UI freeze
  const TILE_CHUNK = 60;
  let tileRenderLimit = $state(TILE_CHUNK);
  let tileRafId: number | null = null;

  $effect(() => {
    const entries = explorer.displayEntries;

    if (tileRafId) cancelAnimationFrame(tileRafId);

    if (entries.length <= TILE_CHUNK) {
      tileRenderLimit = entries.length;
      return;
    }

    tileRenderLimit = TILE_CHUNK;

    function renderMore() {
      tileRenderLimit = Math.min(tileRenderLimit + TILE_CHUNK, entries.length);
      if (tileRenderLimit < entries.length) {
        tileRafId = requestAnimationFrame(renderMore);
      }
    }
    tileRafId = requestAnimationFrame(renderMore);

    return () => {
      if (tileRafId) cancelAnimationFrame(tileRafId);
    };
  });

  const visibleTileEntries = $derived(
    explorer.displayEntries.slice(0, tileRenderLimit)
  );

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

<div class="tiles-view file-rows">
  {#if explorer.isCreatingFolder}
    <InlineNewFolder {explorer} variant="tiles" />
  {/if}
  {#each visibleTileEntries as entry (entry.path)}
    {@const iconColor = getFileIconColor(entry)}
    <button
      class="tile-item entry-item"
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
      <div class="tile-icon" style:color={iconColor}>
        {#if isImageFile(entry)}
          <ThumbnailImage path={entry.path} size={64} fallbackColor={iconColor} />
        {:else}
          <FileIcon {entry} size="large" />
        {/if}
      </div>
      {#if renamingEntry?.path === entry.path}
        <!-- svelte-ignore a11y_autofocus -->
        <textarea
          class="rename-input tile-rename"
          class:error={!!rename.renameError}
          bind:value={rename.editedName}
          bind:this={rename.renameInputRef}
          onkeydown={(e) => rename.handleRenameKeydown(e, entry.name)}
          onblur={() => rename.handleRenameBlur(entry.name)}
          onclick={(e) => e.stopPropagation()}
          disabled={rename.submittingRename}
          rows="2"
          autofocus
        ></textarea>
      {:else}
        <span class="tile-name entry-name" title={entry.name}>{entry.name}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .tiles-view {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
    grid-auto-rows: min-content;
    align-content: start;
    gap: 6px;
    padding: 12px;
    overflow-y: auto;
    flex: 1;
  }

  .tile-item:focus {
    outline: none;
  }

  .tile-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 8px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-bottom-width: var(--selection-indicator-width);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: center;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    transition: background 120ms ease;
    height: fit-content;
    min-width: 0;
  }

  .tile-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .tile-item:active {
    transform: scale(0.97);
  }

  .tile-item.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-bottom-color: var(--accent);
    border-radius: var(--radius-md) var(--radius-md) 2px 2px;
  }

  .tile-item.selected:hover {
    background: var(--subtle-fill-tertiary);
  }

  .tile-item.cut {
    opacity: 0.5;
  }

  .tile-item.in-clipboard:not(.cut) {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }

  .tile-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .tile-item.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
  }

  .tile-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
  }

  .tile-name {
    width: 100%;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    text-overflow: ellipsis;
    white-space: normal;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    padding-top: 1px;
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

  .rename-input.tile-rename {
    width: 100%;
    text-align: center;
    resize: none;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    font-size: 13px;
  }
</style>
