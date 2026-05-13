<!--
  FilesSidebarView - file-tree / bookmarks / recent / drives view
  Extracted from Sidebar.svelte (#52). Renders as the "Explorer" activity-bar view.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getHomeDirectory } from "$lib/api/files";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { drivesStore } from "$lib/state/drives.svelte";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { recentFilesStore } from "$lib/state/recent-files.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { basename } from "$lib/domain/path";
  import { loadPersisted, savePersisted } from "$lib/state/persisted";
  import { useSidebarDrag } from "$lib/composables/use-sidebar-drag.svelte";
  import { isMac } from "$lib/domain/platform";

  const sidebarDrag = isMac ? useSidebarDrag() : null;

  const paneNav = getPaneNavigationContext();
  const navigateTo = (path: string) => {
    if (paneNav) {
      paneNav.navigateTo(path);
    } else {
      windowTabsManager.getActiveExplorer()?.navigateTo(path);
    }
  };

  let homeDir = $state("/home");
  let isDragOver = $state(false);

  let quickAccessEl: HTMLDivElement | undefined;
  let dragPollInterval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    getHomeDirectory().then((result) => {
      if (result.ok) homeDir = result.data;
    });

    drivesStore.startPolling();

    if (quickAccessEl) {
      quickAccessEl.addEventListener("dragenter", onQuickAccessDragEnter);
      quickAccessEl.addEventListener("dragover", onQuickAccessDragOver);
      quickAccessEl.addEventListener("dragleave", onQuickAccessDragLeave);
      quickAccessEl.addEventListener("drop", onQuickAccessDrop);
    }
    document.addEventListener("dragstart", onDragStartPoll);
    document.addEventListener("dragend", onDragEnd, { capture: true });

    return () => {
      if (quickAccessEl) {
        quickAccessEl.removeEventListener("dragenter", onQuickAccessDragEnter);
        quickAccessEl.removeEventListener("dragover", onQuickAccessDragOver);
        quickAccessEl.removeEventListener("dragleave", onQuickAccessDragLeave);
        quickAccessEl.removeEventListener("drop", onQuickAccessDrop);
      }
      document.removeEventListener("dragstart", onDragStartPoll);
      document.removeEventListener("dragend", onDragEnd, { capture: true });
      stopDragPoll();
      drivesStore.stopPolling();
    };
  });

  let lastDragX = 0;
  let lastDragY = 0;

  function onDragStartPoll() {
    stopDragPoll();
    dragPollInterval = setInterval(() => {
      if (!quickAccessEl || !dragState.current) {
        stopDragPoll();
        return;
      }
      if (lastDragX === 0 && lastDragY === 0) return;
      const el = document.elementFromPoint(lastDragX, lastDragY);
      isDragOver = quickAccessEl.contains(el);
    }, 100);
    document.addEventListener("drag", onDragMove);
  }

  function onDragMove(event: DragEvent) {
    if (event.clientX > 0 || event.clientY > 0) {
      lastDragX = event.clientX;
      lastDragY = event.clientY;
    }
  }

  function stopDragPoll() {
    if (dragPollInterval) {
      clearInterval(dragPollInterval);
      dragPollInterval = null;
    }
    document.removeEventListener("drag", onDragMove);
    lastDragX = 0;
    lastDragY = 0;
  }

  function onQuickAccessDragEnter(event: DragEvent) {
    if (dragState.current) {
      event.preventDefault();
    }
  }

  function onQuickAccessDragOver(event: DragEvent) {
    if (dragState.current) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
      isDragOver = true;
    }
  }

  function onQuickAccessDragLeave(event: DragEvent) {
    const rect = quickAccessEl!.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) {
      isDragOver = false;
    }
  }

  function onQuickAccessDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (dragState.current) {
      const { kind, path, name } = dragState.current;
      if (kind === "directory" && path) {
        bookmarksStore.addBookmark(path, name);
      }
    }
    isDragOver = false;
    dragState.clear();
    stopDragPoll();
  }

  function onDragEnd(event: DragEvent) {
    let overQuickAccess = isDragOver;
    if (!overQuickAccess && quickAccessEl && event.clientX > 0 && event.clientY > 0) {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      overQuickAccess = quickAccessEl.contains(el);
    }

    if (overQuickAccess && dragState.current) {
      const { kind, path, name } = dragState.current;
      if (kind === "directory" && path) {
        bookmarksStore.addBookmark(path, name);
      }
    }
    isDragOver = false;
    dragState.clear();
    stopDragPoll();
  }

  const allSystemFolders = $derived([
    { name: "Downloads", icon: "download", path: `${homeDir}/Downloads`, color: "#0078d4" },
    { name: "Documents", icon: "document", path: `${homeDir}/Documents`, color: "#2b579a" },
    { name: "Pictures", icon: "picture", path: `${homeDir}/Pictures`, color: "#008272" },
    { name: "Videos", icon: "video", path: `${homeDir}/Videos`, color: "#a855f7" },
    { name: "Music", icon: "music", path: `${homeDir}/Music`, color: "#f472b6" },
  ]);

  let hiddenSystemFolders = $state<Set<string>>(
    new Set(loadPersisted<string[]>("explorer-hidden-system-folders", []))
  );

  function hideSystemFolder(name: string) {
    hiddenSystemFolders = new Set([...hiddenSystemFolders, name]);
    savePersisted("explorer-hidden-system-folders", [...hiddenSystemFolders]);
  }

  const quickAccessFolders = $derived(
    allSystemFolders.filter((f) => !hiddenSystemFolders.has(f.name))
  );

  function getBookmarkIconColor(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower === "repos" || lower === "repositories" || lower === "projects" || lower === "code") return "#f97316";
    if (lower === "work") return "#0ea5e9";
    return null;
  }

  function isCodeFolder(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === "repos" || lower === "repositories" || lower === "projects" || lower === "code";
  }

  let quickAccessExpanded = $state(true);
  let recentExpanded = $state(true);
  let drivesExpanded = $state(true);

  const recentLocations = $derived.by(() => {
    const bookmarkedPaths = new Set(bookmarksStore.list.map((b) => b.path));
    const systemPaths = new Set(quickAccessFolders.map((f) => f.path));
    const scoreMap = frecencyStore.getScoreMap();

    return frecencyStore.entries
      .filter((e) => e.path !== homeDir && e.path !== "/home" && e.path !== "/" && !bookmarkedPaths.has(e.path) && !systemPaths.has(e.path))
      .map((e) => ({ path: e.path, name: basename(e.path), score: scoreMap.get(e.path) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, settingsStore.recentItemsCount);
  });

  // Lazily prune entries pointing at paths that no longer exist. Runs once
  // on mount (deferred so it doesn't compete with first-paint stat I/O) and
  // on visibility regain so deletions made elsewhere clear up promptly.
  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      frecencyStore.pruneNonExistent();
      recentFilesStore.pruneNonExistent();
    }, 1500);

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        frecencyStore.pruneNonExistent();
        recentFilesStore.pruneNonExistent();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  });

  function removeBookmark(event: MouseEvent, path: string) {
    event.stopPropagation();
    bookmarksStore.removeBookmark(path);
  }

  let draggedBookmarkIndex = $state<number | null>(null);
  let dropTargetIndex = $state<number | null>(null);

  function handleBookmarkDragStart(event: DragEvent, index: number) {
    if (!event.dataTransfer) return;
    draggedBookmarkIndex = index;
    event.dataTransfer.setData("application/x-bookmark-index", String(index));
    event.dataTransfer.effectAllowed = "move";
  }

  function handleBookmarkDragOver(event: DragEvent, index: number) {
    if (draggedBookmarkIndex !== null) {
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      dropTargetIndex = index;
      return;
    }
    if (event.dataTransfer?.types.includes("application/x-explorer-kind")) {
      event.preventDefault();
    }
  }

  function handleBookmarkDragLeave() {
    dropTargetIndex = null;
  }

  function handleBookmarkDrop(event: DragEvent, toIndex: number) {
    if (draggedBookmarkIndex === null) return;
    event.preventDefault();
    if (draggedBookmarkIndex !== toIndex) {
      bookmarksStore.reorderBookmarks(draggedBookmarkIndex, toIndex);
    }
    draggedBookmarkIndex = null;
    dropTargetIndex = null;
  }

  function handleBookmarkDragEnd() {
    draggedBookmarkIndex = null;
    dropTargetIndex = null;
  }
</script>

<div class="sidebar-view files-view">
  <div
    bind:this={quickAccessEl}
    class="nav-section quick-access"
    class:drag-over={isDragOver}
    role="region"
    aria-label="Bookmarks - drop folders here to bookmark"
  >
    <button
      class="section-header"
      onclick={() => quickAccessExpanded = !quickAccessExpanded}
      aria-expanded={quickAccessExpanded}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={quickAccessExpanded}>
        <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Bookmarks</span>
      {#if isDragOver}
        <span class="drop-hint">Drop to pin</span>
      {/if}
    </button>

    {#if quickAccessExpanded}
      <div class="section-content">
        {#each quickAccessFolders as folder}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="nav-item folder-item" onclick={() => navigateTo(folder.path)}>
            {#if folder.icon === "download"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {folder.color}">
                <path d="M8 2V10M8 10L5 7M8 10L11 7M3 12H13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {:else if folder.icon === "document"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {folder.color}">
                <path d="M4 2C4 1.44772 4.44772 1 5 1H11L15 5V14C15 14.5523 14.5523 15 14 15H5C4.44772 15 4 14.5523 4 14V2Z" stroke="currentColor" stroke-width="1.25"/>
                <path d="M11 1V4C11 4.55228 11.4477 5 12 5H15" stroke="currentColor" stroke-width="1.25"/>
              </svg>
            {:else if folder.icon === "picture"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {folder.color}">
                <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
                <circle cx="5.5" cy="6.5" r="1" fill="currentColor"/>
                <path d="M2 10L5 7L8 10L11 7L14 10V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V10Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
            {:else if folder.icon === "video"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {folder.color}">
                <rect x="2" y="4" width="9" height="8" rx="1" stroke="currentColor" stroke-width="1.25"/>
                <path d="M11 7L14 5V11L11 9" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
            {:else if folder.icon === "music"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {folder.color}">
                <path d="M6 11.5C6 12.3284 5.32843 13 4.5 13C3.67157 13 3 12.3284 3 11.5C3 10.6716 3.67157 10 4.5 10C5.32843 10 6 10.6716 6 11.5ZM6 11.5V3L13 2V9.5M13 9.5C13 10.3284 12.3284 11 11.5 11C10.6716 11 10 10.3284 10 9.5C10 8.67157 10.6716 8 11.5 8C12.3284 8 13 8.67157 13 9.5Z" stroke="currentColor" stroke-width="1.25"/>
              </svg>
            {/if}
            <span>{folder.name}</span>
            <button
              class="remove-bookmark"
              onclick={(e) => { e.stopPropagation(); hideSystemFolder(folder.name); }}
              title="Remove from Bookmarks"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        {/each}

        {#each bookmarksStore.list as bookmark, index}
          <div
            class="nav-item folder-item user-bookmark"
            class:dragging={draggedBookmarkIndex === index}
            class:drop-target={dropTargetIndex === index && draggedBookmarkIndex !== index}
            onclick={() => navigateTo(bookmark.path)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(bookmark.path); }}}
            draggable="true"
            ondragstart={(e) => handleBookmarkDragStart(e, index)}
            ondragover={(e) => handleBookmarkDragOver(e, index)}
            ondragleave={handleBookmarkDragLeave}
            ondrop={(e) => handleBookmarkDrop(e, index)}
            ondragend={handleBookmarkDragEnd}
            role="button"
            tabindex="0"
          >
            {#if isCodeFolder(bookmark.name)}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {getBookmarkIconColor(bookmark.name) ?? 'var(--icon-folder, #ffb900)'}">
                <path d="M5 4L2 8L5 12M11 4L14 8L11 12M9 3L7 13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {getBookmarkIconColor(bookmark.name) ?? 'var(--icon-folder, #ffb900)'}">
                <path
                  d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L8.12132 5.53553C8.30886 5.72307 8.56321 5.82843 8.82843 5.82843H13C13.8284 5.82843 14.5 6.5 14.5 7.32843V12.5C14.5 13.3284 13.8284 14 13 14H3C2.17157 14 1.5 13.3284 1.5 12.5V5.5"
                  stroke="currentColor"
                  stroke-width="1.25"
                  fill="currentColor"
                  fill-opacity="0.15"
                />
              </svg>
            {/if}
            <span>{bookmark.name}</span>
            <button
              class="remove-bookmark"
              onclick={(e) => removeBookmark(e, bookmark.path)}
              title="Unpin from Bookmarks"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if drivesStore.removable.length > 0}
    <div class="divider"></div>

    <div class="nav-section">
      <button
        class="section-header"
        onclick={() => drivesExpanded = !drivesExpanded}
        aria-expanded={drivesExpanded}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={drivesExpanded}>
          <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Removable Drives</span>
      </button>

      {#if drivesExpanded}
        <div class="section-content">
          {#each drivesStore.removable as drive (drive.path)}
            <button class="nav-item" onclick={() => navigateTo(drive.path)} title={drive.path}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: #10b981">
                <rect x="2" y="4" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.25"/>
                <circle cx="11" cy="8" r="0.9" fill="currentColor"/>
                <path d="M4 4V3M6 4V3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
              </svg>
              <span>{drive.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if recentLocations.length > 0}
    <div class="divider"></div>

    <div class="nav-section">
      <button
        class="section-header"
        onclick={() => recentExpanded = !recentExpanded}
        aria-expanded={recentExpanded}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={recentExpanded}>
          <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Recent</span>
      </button>

      {#if recentExpanded}
        <div class="section-content">
          {#each recentLocations as loc (loc.path)}
            <div
              class="nav-item folder-item recent-item"
              onclick={() => navigateTo(loc.path)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(loc.path); }}}
              title={loc.path}
              role="button"
              tabindex="0"
              draggable={!isMac}
              ondragstart={!isMac ? (e) => { dragState.start({ kind: "directory", path: loc.path, name: loc.name }); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "link"; e.dataTransfer.setData("application/x-explorer-kind", "directory"); } } : undefined}
              ondragend={!isMac ? () => dragState.clear() : undefined}
              onmousedown={isMac ? (e) => sidebarDrag!.handlePointerDown(e, loc.path, loc.name) : undefined}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
                <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="var(--icon-folder, #FFB900)" opacity="0.7"/>
              </svg>
              <span>{loc.name}</span>
              <button
                class="remove-bookmark"
                onclick={(e) => { e.stopPropagation(); frecencyStore.remove(loc.path); }}
                title="Remove from Recent"
                aria-label="Remove {loc.name} from recent locations"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .sidebar-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .nav-section {
    display: flex;
    flex-direction: column;
    padding: 4px;
  }

  .divider {
    height: 1px;
    background: var(--divider);
    margin: 6px 12px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: var(--font-size-caption);
    font-weight: var(--font-weight-semibold);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
    width: 100%;
  }

  .section-header:hover {
    background: var(--subtle-fill-secondary);
  }

  .chevron {
    color: var(--text-tertiary);
    transition: transform var(--transition-fast);
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .section-content {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-left: 4px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
    width: 100%;
    min-height: 34px;
  }

  .nav-item:hover:not(:disabled) {
    background: var(--subtle-fill-secondary);
  }

  .nav-item:active:not(:disabled) {
    background: var(--subtle-fill-tertiary);
  }

  .nav-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }

  .nav-item:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .nav-icon {
    flex-shrink: 0;
  }

  .folder-item {
    position: relative;
  }

  .recent-item span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .recent-item .remove-bookmark {
    display: none;
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
  }

  .recent-item:hover .remove-bookmark {
    display: flex;
  }

  .quick-access.drag-over {
    background: rgba(0, 120, 212, 0.1);
    border-radius: 6px;
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }

  .drop-hint {
    margin-left: auto;
    font-size: 11px;
    font-weight: 500;
    color: var(--accent);
    background: rgba(0, 120, 212, 0.15);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .user-bookmark {
    position: relative;
  }

  .folder-item .remove-bookmark,
  .user-bookmark .remove-bookmark {
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: var(--background-card-secondary);
    border: none;
    border-radius: 4px;
    color: var(--text-tertiary);
    cursor: pointer;
    padding: 0;
    transition: all var(--transition-fast);
  }

  .folder-item:hover .remove-bookmark,
  .user-bookmark:hover .remove-bookmark {
    display: flex;
  }

  .folder-item .remove-bookmark:hover,
  .user-bookmark .remove-bookmark:hover {
    background: var(--subtle-fill-secondary);
    color: var(--system-critical);
  }

  .user-bookmark.dragging {
    opacity: 0.5;
  }

  .user-bookmark.drop-target {
    background: var(--subtle-fill-secondary);
    box-shadow: 0 -2px 0 0 var(--accent);
  }
</style>
