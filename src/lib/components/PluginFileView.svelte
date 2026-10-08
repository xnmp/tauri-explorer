<!--
  Renders a plugin-contributed file view (SDK 2) in place of the built-in
  listing. The view receives a pane-scoped handle: every read and action
  targets this pane, not whichever pane is active.
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { FileViewPane, RegisteredFileView } from "$lib/plugins/file-view-registry.svelte";
  import { logFrontendError } from "$lib/api/crash";
  import { folderPaneTileSize, folderTileSize } from "$lib/state/folder-tile-size";
  import { setTileSizeContext } from "$lib/state/tile-size-context";

  interface Props {
    explorer: ExplorerInstance;
    paneId: string;
    view: RegisteredFileView;
    onopen: (entry: FileEntry) => Promise<void>;
  }

  let { explorer, paneId, view, onopen }: Props = $props();
  const owner = untrack(() => view.pluginId);

  const pane: FileViewPane = {
    get paneId() { return paneId; },
    get directory() { return explorer.currentPath; },
    get entries() { return explorer.displayEntries; },
    get selection() { return explorer.getSelectedEntries(); },
    get focusedPath() {
      const cursor = explorer.state.cursorPath;
      if (cursor && explorer.selectedPaths.has(cursor)) return cursor;
      return explorer.getSelectedEntries()[0]?.path ?? null;
    },
    get active() { return windowTabsManager.activePaneId === paneId; },
    get previewTarget() {
      const current = explorer.previewTarget;
      return current?.owner === owner ? current.target : null;
    },
    get tileSize() { return folderPaneTileSize(explorer.currentPath); },
    select(entry, modifiers = {}) {
      windowTabsManager.setActivePane(paneId);
      explorer.selectEntry(entry, { ctrlKey: !!modifiers.ctrlKey, shiftKey: !!modifiers.shiftKey });
    },
    setSelection(paths, focus = null) {
      windowTabsManager.setActivePane(paneId);
      explorer.selectPaths(paths, focus);
    },
    clearSelection() { explorer.clearSelection(); },
    open(entry) { return onopen(entry); },
    contextMenu(event, entry) {
      event.preventDefault();
      event.stopPropagation();
      windowTabsManager.setActivePane(paneId);
      if (!entry) explorer.clearSelection();
      explorer.openContextMenu(event.clientX, event.clientY, entry);
    },
    async navigate(path) { await explorer.navigateTo(path); },
    setPreviewTarget(target) {
      // Showing a new subject is a user action in this pane; refreshing or
      // clearing the current one (e.g. after a background update) is not.
      const current = explorer.previewTarget;
      if (target && !(current?.owner === owner && current.target.id === target.id)) windowTabsManager.setActivePane(paneId);
      explorer.setPreviewTarget(owner, target);
    },
    exitView() { windowTabsManager.setPaneFileView(paneId, null); },
  };

  // `ui/file-tiles` in this view follows the folder's size even when the
  // plugin passes no `size` (e.g. plugins built before "tileSize").
  setTileSizeContext(() => folderTileSize(explorer.currentPath));

  // A Preview target belongs to the view that showed it; it never outlives it
  // (toggle, built-in mode, unavailable folder, plugin disable).
  onDestroy(() => explorer.clearPreviewTargetsOwnedBy(owner));

  function report(error: unknown) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    console.error(`[plugins] file view ${view.id} failed:`, error);
    void logFrontendError(`[plugins] "${owner}" file view ${view.id} failed: ${message}`).catch(() => {});
  }
</script>

<div class="plugin-file-view" data-file-view={view.id}>
  <svelte:boundary onerror={report}>
    <view.component {...view.props} {pane} />
    {#snippet failed(_error, reset)}
      <div class="status" role="alert">
        <span>{view.title} could not be displayed.</span>
        <div class="actions">
          <button type="button" onclick={reset}>Try again</button>
          <button type="button" onclick={() => pane.exitView()}>Return to files</button>
        </div>
      </div>
    {/snippet}
  </svelte:boundary>
</div>

<style>
  .plugin-file-view { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .status { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; flex: 1; color: var(--text-secondary); }
  .actions { display: flex; gap: 8px; }
  button { padding: 4px 12px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  button:hover { background: var(--subtle-fill-secondary); }
</style>
