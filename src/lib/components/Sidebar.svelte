<!--
  Sidebar component - Windows 11 File Explorer Navigation Pane
  Issue: tauri-explorer-sm3p, tauri-explorer-39wl
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { explorer } from "$lib/state/explorer.svelte";
  import { getHomeDirectory } from "$lib/api/files";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";

  let homeDir = $state("/home");
  let isDragOver = $state(false);

  // Resizable sidebar state
  const SIDEBAR_WIDTH_KEY = "explorer-sidebar-width";
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 400;
  const DEFAULT_WIDTH = 240;

  let savedWidth = typeof localStorage !== "undefined"
    ? parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || String(DEFAULT_WIDTH), 10)
    : DEFAULT_WIDTH;

  let sidebarWidth = $state(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, savedWidth)));
  let isResizing = $state(false);

  onMount(async () => {
    const result = await getHomeDirectory();
    if (result.ok) {
      homeDir = result.data;
    }
  });

  // Quick access folders use dynamic home directory
  const quickAccessFolders = $derived([
    { name: "Downloads", icon: "download", path: `${homeDir}/Downloads`, pinned: true, color: "#0078d4" },
    { name: "Documents", icon: "document", path: `${homeDir}/Documents`, pinned: true, color: "#2b579a" },
    { name: "Pictures", icon: "picture", path: `${homeDir}/Pictures`, pinned: true, color: "#008272" },
    { name: "Videos", icon: "video", path: `${homeDir}/Videos`, pinned: false, color: "#a855f7" },
    { name: "Music", icon: "music", path: `${homeDir}/Music`, pinned: false, color: "#f472b6" },
  ]);

  const drives = [
    { name: "Local Disk (C:)", icon: "drive", path: "/", usage: 65 },
    { name: "Data (D:)", icon: "drive", path: "/mnt", usage: 42 },
  ];

  let quickAccessExpanded = $state(true);
  let thisPcExpanded = $state(true);

  // Drag and drop handlers for adding bookmarks
  function handleDragOver(event: DragEvent) {
    // Only accept folder drops
    if (event.dataTransfer?.types.includes("application/x-explorer-kind")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "link";
      isDragOver = true;
    }
  }

  function handleDragLeave(event: DragEvent) {
    // Only reset if leaving the drop zone entirely
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      isDragOver = false;
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragOver = false;

    if (!event.dataTransfer) return;

    const kind = event.dataTransfer.getData("application/x-explorer-kind");
    const path = event.dataTransfer.getData("application/x-explorer-path");
    const name = event.dataTransfer.getData("application/x-explorer-name");

    // Only allow directories to be bookmarked
    if (kind === "directory" && path) {
      bookmarksStore.addBookmark(path, name);
    }
  }

  function removeBookmark(event: MouseEvent, path: string) {
    event.stopPropagation();
    bookmarksStore.removeBookmark(path);
  }

  // Resize handlers
  function startResize(event: MouseEvent) {
    event.preventDefault();
    isResizing = true;

    const startX = event.clientX;
    const startWidth = sidebarWidth;

    function onMouseMove(e: MouseEvent) {
      const delta = e.clientX - startX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
      sidebarWidth = newWidth;
    }

    function onMouseUp() {
      isResizing = false;
      // Save width to localStorage
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
      }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }
</script>

<div class="sidebar-container" class:resizing={isResizing} style="width: {sidebarWidth}px">
  <div class="sidebar">
    <!-- Home / Gallery / Cloud sections -->
  <div class="nav-section top-section">
    <button class="nav-item" onclick={() => explorer.navigateTo(homeDir)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
        <path d="M8 1.5L14.5 7V14C14.5 14.2761 14.2761 14.5 14 14.5H10V10C10 9.72386 9.77614 9.5 9.5 9.5H6.5C6.22386 9.5 6 9.72386 6 10V14.5H2C1.72386 14.5 1.5 14.2761 1.5 14V7L8 1.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
      </svg>
      <span>Home</span>
    </button>

    <button class="nav-item" disabled>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
        <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
        <path d="M2 6H14M5 3V6M11 3V6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <span>Gallery</span>
    </button>

    <button class="nav-item" disabled>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
        <circle cx="8" cy="6" r="3.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M3 12C3 10 5 8.5 8 8.5C11 8.5 13 10 13 12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <span>OneDrive - Personal</span>
    </button>
  </div>

  <div class="divider"></div>

  <!-- Quick access -->
  <div
    class="nav-section quick-access"
    class:drag-over={isDragOver}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
    role="region"
    aria-label="Quick access - drop folders here to bookmark"
  >
    <button
      class="section-header"
      onclick={() => quickAccessExpanded = !quickAccessExpanded}
      aria-expanded={quickAccessExpanded}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={quickAccessExpanded}>
        <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Quick access</span>
      {#if isDragOver}
        <span class="drop-hint">Drop to pin</span>
      {/if}
    </button>

    {#if quickAccessExpanded}
      <div class="section-content">
        <!-- Default system folders -->
        {#each quickAccessFolders as folder}
          <button class="nav-item folder-item" onclick={() => explorer.navigateTo(folder.path)}>
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
            {#if folder.pinned}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="pin-icon">
                <path d="M7 2V5L8 6V8H6.5V11L6 11.5L5.5 11V8H4V6L5 5V2H7Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
              </svg>
            {/if}
          </button>
        {/each}

        <!-- User bookmarks -->
        {#each bookmarksStore.list as bookmark}
          <div
            class="nav-item folder-item user-bookmark"
            onclick={() => explorer.navigateTo(bookmark.path)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); explorer.navigateTo(bookmark.path); }}}
            role="button"
            tabindex="0"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon" style="color: #ffb900">
              <path
                d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L8.12132 5.53553C8.30886 5.72307 8.56321 5.82843 8.82843 5.82843H13C13.8284 5.82843 14.5 6.5 14.5 7.32843V12.5C14.5 13.3284 13.8284 14 13 14H3C2.17157 14 1.5 13.3284 1.5 12.5V5.5"
                stroke="currentColor"
                stroke-width="1.25"
                fill="currentColor"
                fill-opacity="0.15"
              />
            </svg>
            <span>{bookmark.name}</span>
            <button
              class="remove-bookmark"
              onclick={(e) => removeBookmark(e, bookmark.path)}
              title="Unpin from Quick access"
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

  <div class="divider"></div>

  <!-- This PC -->
  <div class="nav-section">
    <button
      class="section-header"
      onclick={() => thisPcExpanded = !thisPcExpanded}
      aria-expanded={thisPcExpanded}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={thisPcExpanded}>
        <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>This PC</span>
    </button>

    {#if thisPcExpanded}
      <div class="section-content">
        {#each drives as drive}
          <button class="nav-item drive-item" onclick={() => explorer.navigateTo(drive.path)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
              <rect x="2" y="4" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.25"/>
              <circle cx="4.5" cy="8" r="0.75" fill="currentColor"/>
              <path d="M2 7H14" stroke="currentColor" stroke-width="1.25"/>
            </svg>
            <div class="drive-details">
              <span class="drive-name">{drive.name}</span>
              <div class="drive-usage">
                <div class="usage-bar">
                  <div class="usage-fill" style="width: {drive.usage}%"></div>
                </div>
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
  </div>
  <!-- Resize handle -->
  <div
    class="resize-handle"
    onmousedown={startResize}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
  ></div>
</div>

<style>
  .sidebar-container {
    display: flex;
    flex-shrink: 0;
    position: relative;
  }

  .sidebar-container.resizing {
    user-select: none;
  }

  .sidebar {
    flex: 1;
    background: var(--background-card-secondary);
    border-right: 1px solid var(--divider);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .resize-handle {
    position: absolute;
    right: -3px;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
    z-index: 10;
    transition: background var(--transition-fast);
  }

  .resize-handle:hover,
  .sidebar-container.resizing .resize-handle {
    background: var(--accent);
  }

  .nav-section {
    display: flex;
    flex-direction: column;
    padding: 4px;
  }

  .top-section {
    padding-top: 8px;
  }

  .divider {
    height: 1px;
    background: var(--divider);
    margin: 4px 8px;
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
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
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
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
    width: 100%;
    min-height: 32px;
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
  }

  .nav-item:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .nav-icon {
    flex-shrink: 0;
  }

  /* Top section icons */
  .top-section .nav-item:nth-child(1) .nav-icon { color: #0078d4; } /* Home - Blue */
  .top-section .nav-item:nth-child(2) .nav-icon { color: #008272; } /* Gallery - Teal */
  .top-section .nav-item:nth-child(3) .nav-icon { color: #0078d4; } /* OneDrive - Blue */

  /* Drive icons */
  .drive-item .nav-icon { color: #6d6d6d; }

  .folder-item {
    position: relative;
  }

  .pin-icon {
    margin-left: auto;
    opacity: 0.4;
  }

  .drive-item {
    align-items: flex-start;
    padding-top: 8px;
    padding-bottom: 8px;
  }

  .drive-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .drive-name {
    font-size: 13px;
  }

  .drive-usage {
    width: 100%;
  }

  .usage-bar {
    height: 3px;
    background: var(--control-fill-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }

  .usage-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  /* Drag and drop styles */
  .quick-access.drag-over {
    background: var(--accent);
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

  /* User bookmark styles */
  .user-bookmark {
    position: relative;
  }

  .user-bookmark .remove-bookmark {
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: auto;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-tertiary);
    cursor: pointer;
    padding: 0;
    transition: all var(--transition-fast);
  }

  .user-bookmark:hover .remove-bookmark {
    display: flex;
  }

  .user-bookmark .remove-bookmark:hover {
    background: var(--subtle-fill-secondary);
    color: var(--system-critical);
  }
</style>
