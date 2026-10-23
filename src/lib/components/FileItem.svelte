<!--
  FileItem component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
-->
<script lang="ts">
  import { positionDropFeedback } from "$lib/state/file-drop-targets.svelte";
  import ImageResolutionCell from "./ImageResolutionCell.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { formatSize } from "$lib/domain/file";
  import { getFileType, getFileIconColor, formatDate, formatAbsoluteDate, isVideoMediaFile } from "$lib/domain/file-types";
  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { emptyFolderResolver } from "$lib/state/empty-folders.svelte";
  import { mediaDurationResolver } from "$lib/state/media-durations.svelte";
  import { formatMediaDuration } from "$lib/domain/media-duration";
  import { useItemInteractions, isInClipboard as checkInClipboard, isClipboardCut } from "$lib/composables/use-item-interactions.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { usesPointerDrag, usesHtml5Drag } from "$lib/domain/platform";

  import { getPaneIdContext } from "$lib/state/pane-context";
  import PeekGuides from "./PeekGuides.svelte";
  import PeekOpenButton from "./PeekOpenButton.svelte";
  import type { PeekGroup } from "$lib/domain/folder-peek";

  interface Props {
    entry: FileEntry;
    index: number;
    onclick: (event: MouseEvent) => void;
    ondblclick: () => void;
    selected?: boolean;
    explorer: ExplorerInstance;
    depth?: number;
    parentPath?: string;
    expanded?: boolean;
    /** The pane renders a peek tree; false is the classic flat Details row. */
    peek?: boolean;
    canPeek?: boolean;
    /** Draw the caret (and its slot); false = a click on the folder toggles it (#1248). */
    carets?: boolean;
    groups?: readonly PeekGroup[];
    rowIndex?: number;
  }

  let { entry, index, onclick, ondblclick, selected = false, explorer, depth = 0, parentPath = explorer.currentPath, expanded = false, peek = false, canPeek = false, carets = true, groups = [], rowIndex = 0 }: Props = $props();

  const paneId = getPaneIdContext();

  // Get pane context for cross-pane operations

  // Shared item interactions (DnD, context menu with select-on-right-click)
  const interactions = useItemInteractions({
    getExplorer: () => explorer,
    refreshPanes: () => windowTabsManager.refreshAllPanes(),
    selectOnContextMenu: true,
  });

  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes() }) : null;

  // Check if this entry is being renamed (used for click guards and badge visibility)
  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);

  // Clipboard state
  const entryInClipboard = $derived(checkInClipboard(entry));
  const isCut = $derived(isClipboardCut(entry));

  const isManuallyHidden = $derived(manualHiddenStore.isHidden(parentPath, entry.name));

  // Emptiness is resolved lazily now that listings no longer carry it (#129).
  // Re-request when hidden-file visibility changes so the resolver reprobes
  // under the new rule. The dimmed style may settle a frame late — acceptable.
  $effect(() => {
    settingsStore.showHidden;
    emptyFolderResolver.request(entry);
  });
  const isEmptyFolder = $derived(
    entry.kind === "directory" && emptyFolderResolver.isEmpty(entry.path) === true,
  );

  // Formatted column values, memoized per entry so re-renders triggered by
  // unrelated state (selection, clipboard, drop-target) never re-format.
  const dateText = $derived(formatDate(entry.modified));
  const absoluteDateText = $derived(formatAbsoluteDate(entry.modified));
  // Trash rows show where the item came from in place of its type (#863).
  const typeText = $derived(entry.trash ? entry.trash.originalFolder ?? "Unknown" : getFileType(entry));
  const sizeText = $derived(entry.kind === "file" ? formatSize(entry.size) : "");

  // Video length is probed lazily for rendered rows only, and only while the
  // Length column is shown; unchanged files reuse the resolver's cache (#995).
  $effect(() => {
    if (settingsStore.columnVisibility.length) mediaDurationResolver.request(entry);
  });
  const lengthText = $derived(formatMediaDuration(mediaDurationResolver.duration(entry)));

  const isPeekControl = (event: Event) => event.target instanceof Element && !!event.target.closest(".peek-caret, .peek-open");
  function handleClick(event: MouseEvent) {
    if (isPeekControl(event)) return;
    if (isRenaming) {
      event.stopPropagation();
      return;
    }
    onclick(event);
  }

  function handleDoubleClick(event: MouseEvent) {
    if (isPeekControl(event)) return;
    // Double-click inside the rename input selects a word — don't open/navigate
    if (isRenaming) {
      event.stopPropagation();
      return;
    }
    ondblclick();
  }
  let rowElement = $state<HTMLElement>();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -- FileList owns cursor navigation; the window command router owns configurable Open/Preview and selection commands. -->
<div
  role="gridcell"
  aria-label={isVideoMediaFile(entry) ? `${entry.name}, video` : undefined}
  tabindex={!isRenaming && explorer.focusedEntry?.path === entry.path ? 0 : -1}
  aria-selected={explorer.isSelected(entry)}
  class="file-item entry-item"
  data-path={entry.path}
  data-index={index}
  style:--peek-indent={peek ? `${depth * 22}px` : undefined}
  class:peek-row={peek}
  aria-colindex={1}
  class:directory={entry.kind === "directory"}
  class:hidden-entry={entry.name.startsWith(".") || isManuallyHidden}
  class:empty-folder={isEmptyFolder}
  class:cut={isCut}
  class:in-clipboard={entryInClipboard}
  class:selected
  class:drop-target={interactions.isDropTarget(entry.path) || positionDropFeedback.matches(rowElement)}
  bind:this={rowElement}
  class:copy-drop={interactions.isCopyDrop(entry.path)}
  onfocus={(event) => {
    // Native keyboard entry can reveal trailing columns and clip the file
    // identity. Pointer selection and cursor moves within the grid must retain
    // the user's horizontal position and FileList's preventScroll choice.
    const grid = event.currentTarget.closest(':is([role="grid"], [role="treegrid"])');
    // A virtual jump can remove the old row before focus, leaving a null
    // relatedTarget. That is still FileList-owned focus, not native Tab entry.
    const fromOutsideGrid = event.relatedTarget instanceof Node && !grid?.contains(event.relatedTarget);
    if (event.currentTarget.matches(":focus-visible") && fromOutsideGrid) {
      event.currentTarget.scrollIntoView({ block: "nearest", inline: "start" });
    }
  }}
  onclick={handleClick}
  ondblclick={handleDoubleClick}
  oncontextmenu={(e) => interactions.handleContextMenu(e, entry)}
  use:interactions.trackDragSource
  draggable={usesHtml5Drag}
  ondragstart={usesHtml5Drag ? (e) => { if (isPeekControl(e)) e.preventDefault(); else interactions.handleDragStart(e, entry, selected); } : undefined}
  ondragend={usesHtml5Drag ? interactions.handleDragEnd : undefined}
  ondragenter={(e) => interactions.handleDragEnter(e, entry)}
  ondragover={(e) => interactions.handleDragOver(e, entry)}
  ondragleave={(e) => interactions.handleDragLeave(e, entry)}
  ondrop={(e) => interactions.handleDrop(e, entry)}
  onmousedown={usesPointerDrag ? (e) => { if (isPeekControl(e)) return; e.stopPropagation(); pointerDrag!.handlePointerDown(e, entry, selected); } : undefined}
>
  <!-- Name column -->
  {#if peek}<PeekGuides {groups} row={rowIndex} {carets} />{/if}
  <div class="name-cell" style:padding-left={peek ? `${depth * 22}px` : undefined}>
    {#if peek && carets}
    <span class="peek-caret-slot">
      {#if canPeek}
        <!-- A pointer affordance only: never a tab stop, and its mousedown keeps
             focus where it was (the row or pane), so the pane keyboard contract
             continues. Keyboard users toggle with the palette's Peek commands;
             assistive tech still gets the button, label and expanded state. -->
        <button class="peek-caret" type="button" draggable={false} tabindex="-1"
          aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => {
            if (paneId) windowTabsManager.setActivePane(paneId);
            explorer.togglePeek(entry.path);
          }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d={expanded ? "M2 3.5 5 6.5 8 3.5" : "M3.5 2 6.5 5 3.5 8"} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      {/if}
    </span>
    {/if}
    <div class="icon" data-drag-icon style:--file-icon-color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined} aria-hidden="true">
      <FileIcon {entry} size="small" />
    </div>
    <span class="name-text" data-drag-name><EntryName {entry} {explorer} variant="details" bold={expanded} /></span>
    {#if explorer.rowClickOwnsPeek(entry) && !isRenaming}<PeekOpenButton {entry} {explorer} />{/if}
    <GitStatusBadge directory={parentPath} entryName={entry.name} hideOnRename={isRenaming} />
    {#if entry.is_symlink && !isRenaming && entry.kind !== "directory"}
      <div class="symlink-badge" title={entry.symlink_target ? `Link to ${entry.symlink_target}` : "Symbolic link"}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M7 3L3 7M3 3L3 7L7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    {/if}
    {#if entryInClipboard && !isRenaming}
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
  {#if settingsStore.columnVisibility.date}
  <div class="date-cell" title={absoluteDateText || undefined}>
    {dateText}
  </div>
  {/if}

  <!-- Type column -->
  {#if settingsStore.columnVisibility.type}
  <div class="type-cell">
    {typeText}
  </div>
  {/if}

  <!-- Size column -->
  {#if settingsStore.columnVisibility.size}
  <div class="size-cell">
    {#if entry.kind === "file"}
      {sizeText}
    {:else}
      <span class="empty-cell">—</span>
    {/if}
  </div>
  {/if}

  <!-- Length column -->
  {#if settingsStore.columnVisibility.length}
  <div class="length-cell">
    {lengthText}
  </div>
  {/if}
  {#if settingsStore.columnVisibility.resolution}
    <div class="resolution-cell"><ImageResolutionCell {entry} /></div>
  {/if}
</div>

<style>
  .peek-caret-slot { width: 22px; flex: 0 0 22px; margin-right: -10px; display: flex; align-items: center; }
  .peek-caret { display: flex; align-items: center; justify-content: center; width: 22px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; border-radius: var(--radius-sm); }
  .peek-caret:hover { background: var(--subtle-fill-tertiary); color: var(--text-primary); }
  .peek-caret:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .file-item.peek-row.selected::after { content: ""; position: absolute; left: calc(16px + var(--peek-indent)); top: 0; bottom: 0; width: 3px; background: var(--accent); pointer-events: none; }

  .file-item {
    display: grid;
    grid-template-columns: var(--details-grid-columns, var(--col-name, 300px) var(--col-date, 180px) var(--col-type, 120px) var(--col-size, 90px) var(--col-length, 90px) var(--col-resolution, 160px));
    gap: 0;
    align-items: center;
    padding: 4px 16px;
    background: transparent;
    border: 1px solid transparent;
    border-left-width: var(--selection-indicator-width);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: inherit;
    color: var(--text-primary);
    position: relative;
    box-sizing: border-box;
    height: 32px;
  }

  .file-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .file-item:active {
    background: var(--subtle-fill-tertiary);
  }

  .file-item:focus-visible {
    outline: none;
  }

  /* Selected state - accent-tinted background */
  .file-item.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  /* The tree's bar sits at the row's indent instead. Same specificity as the
     rule above (later wins); FileList's keyboard focus edge still overrides. */
  .file-item.peek-row:where(.selected) {
    border-left-color: transparent;
  }

  .file-item.selected:hover {
    background: var(--subtle-fill-tertiary);
  }

  /* Cut items appear faded */
  /* Ghosted entries (hidden, empty folder, cut) dim their icon and quiet
     their label to --text-secondary. Dimming the whole row pulled the name
     below WCAG AA contrast in every theme (#785); Windows Explorer ghosts
     the icon for the same states. */
  .file-item:is(.hidden-entry, .empty-folder, .cut) {
    color: var(--text-secondary);
  }

  .file-item:is(.hidden-entry, .empty-folder) [data-drag-icon] {
    opacity: 0.55;
  }

  .file-item:is(.hidden-entry, .empty-folder):is(:hover, .selected) [data-drag-icon] {
    opacity: 0.8;
  }

  .file-item.cut [data-drag-icon] {
    opacity: 0.5;
  }

  .file-item.in-clipboard:where(:not(.cut)) {
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.06), rgba(0, 120, 212, 0.02));
    border-color: rgba(0, 120, 212, 0.2);
  }

  /* Name cell */
  .name-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    overflow: hidden;
    box-sizing: border-box;
  }

  /* While renaming, let the (content-width) rename box extend past the name
     column over the neighbouring columns instead of being clipped to it. */
  .file-item:has(:global(.rename-input)) {
    z-index: 2;
  }
  .file-item:has(:global(.rename-input)) .name-cell,
  .file-item:has(:global(.rename-input)) .name-text {
    overflow: visible;
  }

  .name-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .name-cell:has(:global(.peek-open)) .name-text {
    flex: 0 1 auto;
  }

  /* Icon container */
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }

  /* File icon colors - theme can override via --icon-file-tint */
  .file-item:not(.directory) .icon {
    color: var(--icon-file-tint, var(--file-icon-color, var(--text-secondary)));
  }

  /* Name styles are handled by EntryName component */

  /* Date, Type, Size cells */
  .date-cell,
  .type-cell,
  .size-cell,
  .length-cell,
  .resolution-cell {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size-cell,
  .length-cell {
    text-align: right;
    padding-right: 8px;
  }

  .length-cell {
    font-variant-numeric: tabular-nums;
  }

  .empty-cell {
    opacity: 0.3;
  }

  /* Symlink badge */
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

  /* Drop target state - for drag-to-move */
  .file-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  /* Copy drop visual - green tint when Ctrl held */
  .file-item.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    outline: 1px solid #10b981;
    outline-offset: -1px;
  }

</style>
