<!--
  FilesSidebarView - file-tree / bookmarks / recent / drives view
  Extracted from Sidebar.svelte (#52). Renders as the "Explorer" activity-bar view.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { homeDirectory } from "$lib/state/home.svelte";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { drivesStore } from "$lib/state/drives.svelte";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { recentFilesStore } from "$lib/state/recent-files.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { basename, directoryKey } from "$lib/domain/path";
  import { loadPersisted, savePersisted } from "$lib/state/persisted";
  import { useSidebarDrag } from "$lib/composables/use-sidebar-drag.svelte";
  import { usesPointerDrag, usesHtml5Drag } from "$lib/domain/platform";
  import { openRecycleBin } from "$lib/api/open";
  import { openRecycleBinWithFeedback } from "$lib/domain/recycle-bin";
  import { toastStore } from "$lib/state/toast.svelte";

  const sidebarDrag = usesPointerDrag ? useSidebarDrag() : null;

  // Window-global surface: navigates whichever pane is active.
  const navigateTo = (path: string) => {
    windowTabsManager.getActiveExplorer()?.navigateTo(path);
  };

  function handleOpenRecycleBin() {
    void openRecycleBinWithFeedback(openRecycleBin, toastStore.error);
  }

  const homeDir = $derived(homeDirectory.value ?? "/home");
  let isDragOver = $state(false);

  let quickAccessEl: HTMLDivElement | undefined;
  let dragPollInterval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
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

  // Accept the drop if either our in-memory drag state is set OR the
  // DataTransfer carries our app's drag MIME. The MIME check is the fallback
  // for cases where the drag source can't initiate the native OS shell drag
  // (e.g. UNC paths skip tauri-plugin-drag); without it the browser's
  // HTML5-only DnD ends up with dropEffect "none" and shows the cancel cursor.
  function isExplorerDrag(event: DragEvent): boolean {
    if (dragState.current) return true;
    return event.dataTransfer?.types.includes("application/x-explorer-kind") ?? false;
  }

  function onQuickAccessDragEnter(event: DragEvent) {
    if (isExplorerDrag(event)) {
      event.preventDefault();
    }
  }

  function onQuickAccessDragOver(event: DragEvent) {
    if (isExplorerDrag(event)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
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

  // Context menu on the Bookmarks header offering to restore removed
  // system folders — without this, hiding one is irreversible.
  let bookmarksMenuPos = $state<{ x: number; y: number } | null>(null);

  function onBookmarksHeaderContextMenu(event: MouseEvent) {
    event.preventDefault();
    bookmarksMenuPos = { x: event.clientX, y: event.clientY };
  }

  function restoreDefaultFolders() {
    hiddenSystemFolders = new Set();
    savePersisted("explorer-hidden-system-folders", []);
    bookmarksMenuPos = null;
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
  let cloudExpanded = $state(true);

  // A recent path that lives on a removable/mounted drive must disappear when
  // that drive is ejected. We detect a "removable root" for a path (a Windows
  // drive letter, or a Linux/macOS mount base) and hide the path when that root
  // isn't in the currently-mounted set. Fixed locations (no removable root) are
  // never hidden by this rule. Recomputes when drivesStore refreshes.
  function ejectedDriveHidesPath(path: string, mounted: Set<string>): boolean {
    // Windows drive letter (e.g. "E:\\foo" or "E:/foo").
    const win = path.match(/^([a-zA-Z]):[\\/]/);
    if (win) {
      const root = `${win[1].toLowerCase()}:`;
      // C: is the system drive and always mounted; only guard other letters.
      if (root === "c:") return false;
      return !mounted.has(root);
    }
    // WSL / UNC roots (\\wsl$\Distro\... or \\server\share\...).
    const unc = path.match(/^\\\\[^\\]+\\[^\\]+/);
    if (unc) {
      return !mounted.has(unc[0].toLowerCase());
    }
    // Linux/macOS removable mount bases.
    const mountBase = path.match(/^(\/(?:run\/)?media\/[^/]+\/[^/]+|\/Volumes\/[^/]+)/);
    if (mountBase) {
      return !mounted.has(mountBase[1].toLowerCase());
    }
    return false;
  }

  const recentLocations = $derived.by(() => {
    // Normalise with directoryKey so a bookmarked/system folder is excluded
    // regardless of trailing-slash or case differences (Windows) between how it
    // was bookmarked and how it was recorded in frecency.
    const bookmarkedPaths = new Set(bookmarksStore.list.map((b) => directoryKey(b.path)));
    const systemPaths = new Set(quickAccessFolders.map((f) => directoryKey(f.path)));
    const scoreMap = frecencyStore.getScoreMap();
    const mounted = drivesStore.mountedRoots;

    return frecencyStore.entries
      .filter((e) => e.path !== homeDir && e.path !== "/home" && e.path !== "/" && !bookmarkedPaths.has(directoryKey(e.path)) && !systemPaths.has(directoryKey(e.path)))
      .filter((e) => !ejectedDriveHidesPath(e.path, mounted))
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
      event.dataTransfer.dropEffect = "copy";
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
      oncontextmenu={onBookmarksHeaderContextMenu}
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
          <div
            class="nav-item folder-item"
            onclick={() => navigateTo(folder.path)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(folder.path); }}}
            role="button"
            tabindex="0"
          >
            {#if folder.icon === "download"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {folder.color}">
                <path d="M8 2V10M8 10L5 7M8 10L11 7M3 12H13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {:else if folder.icon === "document"}
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: {folder.color}">
                <path d="M4 2C4 1.44772 4.44772 1 5 1H11L15 5V14C15 14.5523 14.5523 15 14 15H5C4.44772 15 4 14.5523 4 14V2Z" stroke="currentColor" stroke-width="1.25"/>
                <path d="M11 1V4C11 4.55228 11.4477 5 12 5H15" stroke="currentColor" stroke-width="1.25"/>
                <path d="M6.5 7.5H12.5M6.5 10H12.5M6.5 12.5H10" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
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

        {#if settingsStore.showRecycleBin}
          <button class="nav-item recycle-bin-item" onclick={handleOpenRecycleBin} aria-label="Open Recycle Bin">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: #d97706" aria-hidden="true">
              <path d="M3.5 4.5H12.5L11.7 14H4.3L3.5 4.5ZM6 2H10L10.75 3.5H5.25L6 2ZM2.5 3.5H13.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M6.5 7V11.5M9.5 7V11.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
            </svg>
            <span>Recycle Bin</span>
          </button>
        {/if}
      </div>
    {/if}

    {#if bookmarksMenuPos}
      <div
        class="section-menu-backdrop"
        onclick={() => bookmarksMenuPos = null}
        oncontextmenu={(e) => { e.preventDefault(); bookmarksMenuPos = null; }}
        onkeydown={(e) => { if (e.key === 'Escape') bookmarksMenuPos = null; }}
        role="presentation"
      ></div>
      <div class="section-menu" style="left: {bookmarksMenuPos.x}px; top: {bookmarksMenuPos.y}px;" role="menu">
        <button
          class="section-menu-item"
          role="menuitem"
          onclick={restoreDefaultFolders}
          disabled={hiddenSystemFolders.size === 0}
        >
          Restore default folders
        </button>
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
            <button class="nav-item drive-item" onclick={() => navigateTo(drive.path)} title={drive.path}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: #10b981">
                <rect x="2" y="4" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.25"/>
                <circle cx="11" cy="8" r="0.9" fill="currentColor"/>
                <path d="M4 4V3M6 4V3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
              </svg>
              <span class="drive-name">{drive.name}</span>
              {#if drive.detail}
                <span class="drive-detail">{drive.detail}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if drivesStore.cloud.length > 0}
    <div class="divider"></div>

    <div class="nav-section">
      <button
        class="section-header"
        onclick={() => cloudExpanded = !cloudExpanded}
        aria-expanded={cloudExpanded}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={cloudExpanded}>
          <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Cloud &amp; Remote</span>
      </button>

      {#if cloudExpanded}
        <div class="section-content">
          {#each drivesStore.cloud as drive (drive.path)}
            <button class="nav-item drive-item" onclick={() => navigateTo(drive.path)} title={drive.path}>
              {#if drive.provider === "googledrive"}
                <!-- Google "G" multi-colour mark -->
                <svg width="16" height="16" viewBox="0 0 48 48" class="nav-icon">
                  <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
                  <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
                  <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"/>
                  <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
                </svg>
              {:else if drive.provider === "wsl"}
                <!-- Tux: the official Linux mascot asset (static/tux.svg) -->
                <img src="/tux.svg" alt="" class="nav-icon tux-icon" width="16" height="16" />
              {:else}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: #3b82f6">
                  <path d="M4 11a3 3 0 0 1 0-6 4 4 0 0 1 7.6-1.2A3 3 0 0 1 12 11H4z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
                </svg>
              {/if}
              <span class="drive-name">{drive.name}</span>
              {#if drive.detail}
                <span class="drive-detail">{drive.detail}</span>
              {/if}
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
              draggable={usesHtml5Drag}
              ondragstart={usesHtml5Drag ? (e) => { dragState.start({ kind: "directory", path: loc.path, name: loc.name }); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "link"; e.dataTransfer.setData("application/x-explorer-kind", "directory"); } } : undefined}
              ondragend={usesHtml5Drag ? () => dragState.clear() : undefined}
              onmousedown={usesPointerDrag ? (e) => sidebarDrag!.handlePointerDown(e, loc.path, loc.name) : undefined}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" data-drag-icon>
                <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="var(--icon-folder, #FFB900)" opacity="0.7"/>
              </svg>
              <span data-drag-name>{loc.name}</span>
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

  /* Tux is taller than wide (216×256); contain keeps the mascot un-squished
     inside the 16×16 icon slot. */
  .tux-icon {
    width: 16px;
    height: 16px;
    object-fit: contain;
  }

  .drive-item .drive-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .drive-detail {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-tertiary);
    letter-spacing: var(--letter-spacing-wide);
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

  .section-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .section-menu {
    position: fixed;
    z-index: 100;
    min-width: 180px;
    padding: 4px;
    background: var(--background-card, var(--background-solid));
    border: 1px solid var(--divider);
    border-radius: var(--radius-md, 6px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }

  .section-menu-item {
    display: block;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }

  .section-menu-item:hover:not(:disabled) {
    background: var(--subtle-fill-secondary);
  }

  .section-menu-item:disabled {
    color: var(--text-tertiary);
    cursor: default;
  }
</style>
