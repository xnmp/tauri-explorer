<!--
  Context Menu component - Windows 11 Fluent Design
  Right-click menu for file operations
  Issue: tauri-explorer-83z, tauri-explorer-1k9k
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { contextMenuStore } from "$lib/state/context-menu.svelte";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { settingsStore, type ThumbnailSize } from "$lib/state/settings.svelte";
  import { folderViewsStore } from "$lib/state/folder-views.svelte";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { openFile } from "$lib/api/files";
  import { setWallpaper, openTerminal } from "$lib/state/commands/system-actions";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { parentDir } from "$lib/domain/path";
  import { isImageFile } from "$lib/domain/file-types";
  import { getZoomFactor, clientToFixed } from "$lib/domain/zoom";
  import type { ViewMode } from "$lib/state/types";
  import { contextMenuItems } from "$lib/state/context-menu-items.svelte";

  interface Props {
    explorer: ExplorerInstance;
  }

  let { explorer }: Props = $props();

  // Plugin-contributed context-menu items whose `when` predicate passes for the
  // current selection. Rendered in a divider-separated section below.
  const pluginMenuItems = $derived(contextMenuItems.itemsFor(explorer.getSelectedEntries()));

  function runPluginItem(item: (typeof pluginMenuItems)[number]): void {
    void item.handler(explorer.getSelectedEntries());
    contextMenuStore.close();
  }

  function withSelectedEntry(action: (entry: FileEntry) => void): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) {
      action(entries[0]);
    }
    contextMenuStore.close();
  }

  /** Mark the current folder as actively worked-in for Recent ranking. Called
   *  by the right-click actions that operate on files (open, wallpaper, cut,
   *  copy, delete, rename, …) — so the Recent list reflects folders where the
   *  user actually acts on files, not ones merely browsed through. */
  function recordActioned(): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) frecencyStore.recordFileAction(entries[0].path);
  }

  const hasSelection = $derived(explorer.selectedPaths.size > 0);

  /** Check if the single selected entry is a bookmarkable directory */
  const selectedDirectory = $derived.by((): FileEntry | null => {
    const entries = explorer.getSelectedEntries();
    if (entries.length !== 1) return null;
    return entries[0].kind === "directory" ? entries[0] : null;
  });

  const isBookmarked = $derived(
    selectedDirectory ? bookmarksStore.hasBookmark(selectedDirectory.path) : false
  );

  /** Whether any selected entry is currently in the manual-hidden list. */
  const anySelectedHidden = $derived.by(() => {
    const entries = explorer.getSelectedEntries();
    if (entries.length === 0) return false;
    return entries.some((e) => manualHiddenStore.isHidden(parentDir(e.path), e.name));
  });

  /** Whether all selected entries are currently in the manual-hidden list. */
  const allSelectedHidden = $derived.by(() => {
    const entries = explorer.getSelectedEntries();
    if (entries.length === 0) return false;
    return entries.every((e) => manualHiddenStore.isHidden(parentDir(e.path), e.name));
  });

  function handleManualHide(): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) recordActioned();
    for (const e of entries) {
      manualHiddenStore.hide(parentDir(e.path), [e.name]);
    }
    contextMenuStore.close();
  }

  function handleManualUnhide(): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) recordActioned();
    for (const e of entries) {
      manualHiddenStore.unhide(parentDir(e.path), [e.name]);
    }
    contextMenuStore.close();
  }

  function handleCut(): void {
    const selected = explorer.getSelectedEntries();
    if (selected.length > 0) {
      recordActioned();
      explorer.cutToClipboard(selected);
    }
    contextMenuStore.close();
  }

  function handleCopy(): void {
    const selected = explorer.getSelectedEntries();
    if (selected.length > 0) {
      recordActioned();
      explorer.copyToClipboard(selected);
    }
    contextMenuStore.close();
  }

  async function handlePaste(): Promise<void> {
    await explorer.paste();
    contextMenuStore.close();
  }

  function handleRename(): void {
    recordActioned();
    withSelectedEntry((entry) => explorer.startRename(entry));
  }

  function handleDelete(): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) {
      recordActioned();
      explorer.startDelete(entries);
    }
    contextMenuStore.close();
  }

  function handleNewFolder(): void {
    explorer.startInlineNewFolder();
    contextMenuStore.close();
  }

  function handleSetViewMode(mode: ViewMode): void {
    explorer.setViewMode(mode);
    contextMenuStore.close();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      contextMenuStore.close();
    }
  }

  const ARCHIVE_EXTENSIONS = new Set(["zip", "jar", "war", "ear"]);

  const selectedArchive = $derived.by((): FileEntry | null => {
    const entries = explorer.getSelectedEntries();
    if (entries.length !== 1 || entries[0].kind !== "file") return null;
    const ext = entries[0].name.split(".").pop()?.toLowerCase() ?? "";
    return ARCHIVE_EXTENSIONS.has(ext) ? entries[0] : null;
  });

  async function handleExtractHere(): Promise<void> {
    if (!selectedArchive) return;
    recordActioned();
    await explorer.extractArchive(selectedArchive.path, true);
    contextMenuStore.close();
  }

  async function handleExtractToFolder(): Promise<void> {
    if (!selectedArchive) return;
    recordActioned();
    await explorer.extractArchive(selectedArchive.path, false);
    contextMenuStore.close();
  }

  async function handleCompress(): Promise<void> {
    const selected = explorer.getSelectedEntries();
    if (selected.length === 0) return;
    recordActioned();
    await explorer.compressToZip(selected.map((e) => e.path));
    contextMenuStore.close();
  }

  async function handleCreateSymlink(): Promise<void> {
    const entries = explorer.getSelectedEntries();
    if (entries.length !== 1) return;
    recordActioned();
    await explorer.createSymlink(entries[0].path);
    contextMenuStore.close();
  }

  /** The single selected file (not directory) for Open With */
  const selectedFile = $derived.by((): FileEntry | null => {
    const entries = explorer.getSelectedEntries();
    if (entries.length !== 1 || entries[0].kind !== "file") return null;
    return entries[0];
  });

  /** The single selected image file for wallpaper action */
  const selectedImage = $derived.by((): FileEntry | null => {
    if (!selectedFile) return null;
    return isImageFile(selectedFile) ? selectedFile : null;
  });

  async function handleOpenDefault(): Promise<void> {
    if (!selectedFile) return;
    recordActioned();
    await openFile(selectedFile.path);
    contextMenuStore.close();
  }

  async function handleSetAsWallpaper(): Promise<void> {
    if (!selectedImage) return;
    recordActioned();
    await setWallpaper(selectedImage.path);
    contextMenuStore.close();
  }

  async function handleOpenInTerminal(): Promise<void> {
    await openTerminal(explorer.currentPath);
    contextMenuStore.close();
  }

  const viewModes: { id: ViewMode; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "list", label: "List" },
    { id: "tiles", label: "Tiles" },
  ];

  let menuEl: HTMLDivElement | undefined = $state();
  let listSubmenuOpen = $state(false);
  let tilesSubmenuOpen = $state(false);

  const tileSizeLabels: Record<string, string> = { small: "Small", medium: "Medium", large: "Large", xlarge: "Extra Large" };

  const effectiveThumbnailSize = $derived(
    folderViewsStore.getThumbnailSize(explorer.currentPath, settingsStore.thumbnailSize)
  );

  // Compute submenu flip direction from the already-clamped menu position
  // and viewport size. All values are in CSS pixels — no getBoundingClientRect
  // needed, avoiding WebKitGTK zoom inconsistencies.
  const submenuFlip = $derived.by(() => {
    if (!menuEl) return { flipLeft: false, flipUp: false };
    const zoom = getZoomFactor();
    const vw = document.documentElement.clientWidth / zoom;
    const vh = document.documentElement.clientHeight / zoom;
    const menuW = menuEl.offsetWidth;
    const menuH = menuEl.offsetHeight;
    const submenuW = 140; // generous estimate for submenu width
    const submenuH = 280; // generous estimate for tallest submenu (List: 8 items)
    return {
      flipLeft: clampedX + menuW + submenuW > vw - 8,
      flipUp: clampedY + menuH + submenuH > vh - 8,
    };
  });

  // Clamp menu position to viewport after layout.
  // Uses visibility: hidden on first frame to measure without flicker,
  // then applies clamped position and shows on the next frame.
  let clampedX = $state(0);
  let clampedY = $state(0);
  let menuVisible = $state(false);

  $effect(() => {
    if (!menuEl || !contextMenuStore.isOpen || !contextMenuStore.position) {
      menuVisible = false;
      return;
    }
    const { x: rawX, y: rawY } = contextMenuStore.position;
    // Reset visibility for measurement — place at raw position (hidden)
    menuVisible = false;
    clampedX = rawX;
    clampedY = rawY;
    // Note: clampedX/Y here are physical pixels from clientX/Y, not yet
    // zoom-adjusted. The rAF callback below converts to CSS pixels.

    // Measure after layout, clamp, then reveal.
    // Use offsetWidth/offsetHeight instead of getBoundingClientRect — the latter
    // returns the animated (scaled-down) size due to the menuIn animation.
    requestAnimationFrame(() => {
      if (!menuEl) return;
      // With CSS zoom, position:fixed coordinates are in CSS pixels but the
      // visible viewport shrinks. clientWidth/Height return physical pixels,
      // so divide by zoom to get the usable CSS-pixel viewport.
      // offsetWidth/Height are CSS pixels (unaffected by zoom).
      // rawX/rawY (event.clientX/Y) need the same zoom division as the
      // viewport so the ratio is consistent regardless of whether the
      // engine reports them as physical or CSS pixels.
      const zoom = getZoomFactor();
      const vw = document.documentElement.clientWidth / zoom;
      const vh = document.documentElement.clientHeight / zoom;
      const menuW = menuEl.offsetWidth;
      const menuH = menuEl.offsetHeight;
      const pad = 12;
      // rawX/rawY are the raw event.clientX/Y (the store no longer pre-divides).
      // clientToFixed converts the cursor point into the position:fixed CSS space
      // per webview engine (see zoom.ts).
      let x = clientToFixed(rawX);
      let y = clientToFixed(rawY);
      if (x + menuW > vw - pad) x = vw - menuW - pad;
      if (y + menuH > vh - pad) y = vh - menuH - pad;
      if (x < pad) x = pad;
      if (y < pad) y = pad;
      clampedX = x;
      clampedY = y;
      menuVisible = true;
    });
  });
</script>

<svelte:window on:keydown={handleKeydown} />

{#if contextMenuStore.isOpen && contextMenuStore.position && contextMenuStore.owner === explorer.contextMenuOwner}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="context-menu-backdrop"
    onclick={() => contextMenuStore.close()}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
      // Save coordinates before closing — Svelte needs a frame to remove
      // the backdrop from the DOM, so elementFromPoint must run after that.
      const { clientX, clientY } = e;
      contextMenuStore.close();
      requestAnimationFrame(() => {
        const el = document.elementFromPoint(clientX, clientY);
        if (el) {
          el.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            button: 2,
          }));
        }
      });
    }}
  ></div>

  <div
    bind:this={menuEl}
    class="context-menu"
    style="left: {clampedX}px; top: {clampedY}px; visibility: {menuVisible ? 'visible' : 'hidden'};"
    role="menu"
  >
    {#if hasSelection}
      {#if selectedFile}
        <!-- Open file with default application -->
        <button class="menu-item" onclick={handleOpenDefault} role="menuitem">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 2H8L10 4H13C13.5523 4 14 4.44772 14 5V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V3C2 2.44772 2.44772 2 3 2Z" stroke="currentColor" stroke-width="1.25"/>
            <path d="M6 8L8 10L10 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Open</span>
          <span class="shortcut">Enter</span>
        </button>
        {#if selectedImage}
          <button class="menu-item" onclick={handleSetAsWallpaper} role="menuitem">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
              <circle cx="5.5" cy="6.5" r="1.5" stroke="currentColor" stroke-width="1"/>
              <path d="M2 11L5 8L7 10L10 7L14 11" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Set as Desktop Background</span>
          </button>
        {/if}
        <div class="menu-divider"></div>
      {/if}

      <!-- File/folder operations -->
      <button class="menu-item" onclick={handleCut} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 3L3 6L6 9M10 3L13 6L10 9M4 6H12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Cut</span>
        <span class="shortcut">Ctrl+X</span>
      </button>

      <button class="menu-item" onclick={handleCopy} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="8" height="9" rx="1" stroke="currentColor" stroke-width="1.25"/>
          <path d="M11 5V3C11 2.44772 10.5523 2 10 2H4C3.44772 2 3 2.44772 3 3V11C3 11.5523 3.44772 12 4 12H5" stroke="currentColor" stroke-width="1.25"/>
        </svg>
        <span>Copy</span>
        <span class="shortcut">Ctrl+C</span>
      </button>

      <div class="menu-divider"></div>

      <button class="menu-item" onclick={handleRename} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 11.5V13H4.5L11.5 6L10 4.5L3 11.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
          <path d="M10 4.5L11.5 3L13 4.5L11.5 6L10 4.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
        </svg>
        <span>Rename</span>
        <span class="shortcut">F2</span>
      </button>

      <button class="menu-item danger" onclick={handleDelete} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 5H12M5 5V13C5 13.5523 5.44772 14 6 14H10C10.5523 14 11 13.5523 11 13V5M6 5V3C6 2.44772 6.44772 2 7 2H9C9.55228 2 10 2.44772 10 3V5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Delete</span>
        <span class="shortcut">Del</span>
      </button>

      {#if allSelectedHidden}
        <button class="menu-item" onclick={handleManualUnhide} role="menuitem">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 8C2 8 4 4 8 4C12 4 14 8 14 8C14 8 12 12 8 12C4 12 2 8 2 8Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
            <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.25"/>
          </svg>
          <span>Unhide</span>
        </button>
      {:else if !anySelectedHidden}
        <button class="menu-item" onclick={handleManualHide} role="menuitem">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 8C2 8 4 4 8 4C12 4 14 8 14 8C14 8 12 12 8 12C4 12 2 8 2 8Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
            <path d="M3 3L13 13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          </svg>
          <span>Hide</span>
        </button>
      {/if}

      {#if selectedDirectory}
        <div class="menu-divider"></div>
        {#if isBookmarked}
          <button class="menu-item" onclick={() => { bookmarksStore.removeBookmark(selectedDirectory.path); contextMenuStore.close(); }} role="menuitem">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 2V13L8 10L12 13V2H4Z" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
            </svg>
            <span>Remove Bookmark</span>
          </button>
        {:else}
          <button class="menu-item" onclick={() => { bookmarksStore.addBookmark(selectedDirectory.path, selectedDirectory.name); contextMenuStore.close(); }} role="menuitem">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 2V13L8 10L12 13V2H4Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
            </svg>
            <span>Add to Bookmarks</span>
          </button>
        {/if}
      {/if}

      {#if selectedArchive}
        <div class="menu-divider"></div>
        <button class="menu-item" onclick={handleExtractHere} role="menuitem">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/>
            <path d="M8 5V11M5 8L8 11L11 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Extract Here</span>
        </button>
        <button class="menu-item" onclick={handleExtractToFolder} role="menuitem">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/>
            <path d="M8 5V11M5 8L8 11L11 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Extract to Folder</span>
        </button>
      {/if}

      <div class="menu-divider"></div>

      <button class="menu-item" onclick={handleCompress} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/>
          <path d="M8 11V5M5 8L8 5L11 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Compress to ZIP</span>
      </button>

      {#if explorer.getSelectedEntries().length === 1}
        <button class="menu-item" onclick={handleCreateSymlink} role="menuitem">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 4L4 10M4 4V10H10" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Create Symlink</span>
        </button>
      {/if}

    {/if}

    {#if !hasSelection}
      <!-- Background right-click: directory-level actions -->
      <button class="menu-item" onclick={handlePaste} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="4" y="4" width="9" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
          <path d="M6 4V3C6 2.44772 6.44772 2 7 2H10C10.5523 2 11 2.44772 11 3V4" stroke="currentColor" stroke-width="1.25"/>
          <path d="M7 8H10M8.5 6.5V9.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        <span>Paste</span>
        <span class="shortcut">Ctrl+V</span>
      </button>
      <div class="menu-divider"></div>

      <button class="menu-item" onclick={handleNewFolder} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" stroke="currentColor" stroke-width="1.25"/>
          <path d="M8 7.5V10.5M6.5 9H9.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        <span>New folder</span>
      </button>

      <button class="menu-item" onclick={handleOpenInTerminal} role="menuitem">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
          <path d="M4 7L6 9L4 11" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 11H12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        <span>Open in Terminal</span>
      </button>

      <div class="menu-divider"></div>

      <!-- View options -->
      <div class="menu-section-label">View</div>
      {#each viewModes as mode}
        {#if mode.id === "list"}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="submenu-wrapper" class:flip-left={submenuFlip.flipLeft} class:flip-up={submenuFlip.flipUp} onmouseenter={() => listSubmenuOpen = true} onmouseleave={() => listSubmenuOpen = false}>
            <button
              class="menu-item"
              class:selected={explorer.viewMode === mode.id}
              onclick={() => handleSetViewMode(mode.id)}
              role="menuitemradio"
              aria-checked={explorer.viewMode === mode.id}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 4H4M6 4H13M3 8H4M6 8H13M3 12H4M6 12H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <span>{mode.label}</span>
              {#if explorer.viewMode === mode.id}
                <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {/if}
              <svg class="submenu-arrow" width="8" height="8" viewBox="0 0 8 8" fill="none">
                <path d="M3 1.5L6 4L3 6.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            {#if listSubmenuOpen}
              <div class="submenu">
                <div class="menu-section-label">Columns</div>
                <button
                  class="menu-item"
                  class:selected={settingsStore.listViewColumns === 0}
                  onclick={() => { settingsStore.setListViewColumns(0); contextMenuStore.close(); }}
                  role="menuitemradio"
                  aria-checked={settingsStore.listViewColumns === 0}
                >
                  <span>Auto</span>
                  {#if settingsStore.listViewColumns === 0}
                    <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {/if}
                </button>
                {#each [1, 2, 3] as n}
                  <button
                    class="menu-item"
                    class:selected={settingsStore.listViewColumns === n}
                    onclick={() => { settingsStore.setListViewColumns(n); contextMenuStore.close(); }}
                    role="menuitemradio"
                    aria-checked={settingsStore.listViewColumns === n}
                  >
                    <span>{n}</span>
                    {#if settingsStore.listViewColumns === n}
                      <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else if mode.id === "tiles"}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="submenu-wrapper" class:flip-left={submenuFlip.flipLeft} class:flip-up={submenuFlip.flipUp} onmouseenter={() => tilesSubmenuOpen = true} onmouseleave={() => tilesSubmenuOpen = false}>
            <button
              class="menu-item"
              class:selected={explorer.viewMode === mode.id}
              onclick={() => handleSetViewMode(mode.id)}
              role="menuitemradio"
              aria-checked={explorer.viewMode === mode.id}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
                <rect x="9" y="2" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
                <rect x="2" y="9" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
                <rect x="9" y="9" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
              </svg>
              <span>{mode.label}</span>
              {#if explorer.viewMode === mode.id}
                <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {/if}
              <svg class="submenu-arrow" width="8" height="8" viewBox="0 0 8 8" fill="none">
                <path d="M3 1.5L6 4L3 6.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            {#if tilesSubmenuOpen}
              <div class="submenu">
                <div class="menu-section-label">Icon Size</div>
                {#each ["small", "medium", "large", "xlarge"] as size}
                  <button
                    class="menu-item"
                    class:selected={effectiveThumbnailSize === size}
                    onclick={() => { folderViewsStore.set(explorer.currentPath, { thumbnailSize: size as ThumbnailSize }); contextMenuStore.close(); }}
                    role="menuitemradio"
                    aria-checked={effectiveThumbnailSize === size}
                  >
                    <span>{tileSizeLabels[size]}</span>
                    {#if effectiveThumbnailSize === size}
                      <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <button
            class="menu-item"
            class:selected={explorer.viewMode === mode.id}
            onclick={() => handleSetViewMode(mode.id)}
            role="menuitemradio"
            aria-checked={explorer.viewMode === mode.id}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4H14M2 8H14M2 12H14" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
            </svg>
            <span>{mode.label}</span>
            {#if explorer.viewMode === mode.id}
              <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {/if}
          </button>
        {/if}
      {/each}
    {/if}

    {#if pluginMenuItems.length > 0}
      <div class="menu-divider"></div>
      {#each pluginMenuItems as item (item.id)}
        <button class="menu-item" onclick={() => runPluginItem(item)} role="menuitem">
          {#if item.icon}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d={item.icon} stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
            </svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.25"/>
            </svg>
          {/if}
          <span>{item.label}</span>
        </button>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .context-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-menu) - 1);
  }

  .context-menu {
    position: fixed;
    z-index: var(--z-menu);
    min-width: 220px;
    padding: 6px;
    background: var(--background-acrylic);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-flyout);
    animation: menuIn 100ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes menuIn {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(-4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 9px 14px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
  }

  .menu-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .menu-item:active {
    background: var(--subtle-fill-tertiary);
  }

  .menu-item svg {
    flex-shrink: 0;
    color: var(--text-secondary);
  }

  .menu-item span:first-of-type {
    flex: 1;
  }

  .shortcut {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .menu-item.danger {
    color: var(--system-critical);
  }

  .menu-item.danger svg {
    color: var(--system-critical);
  }

  .menu-divider {
    height: 1px;
    margin: 4px 8px;
    background: var(--divider);
  }

  .menu-section-label {
    padding: 6px 14px 4px;
    font-size: 10px;
    font-weight: var(--font-weight-semibold);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .menu-item.selected {
    background: var(--subtle-fill-tertiary);
  }

  .check-icon {
    color: var(--accent);
    margin-left: auto;
  }

  .submenu-wrapper {
    position: relative;
  }

  .submenu-arrow {
    color: var(--text-tertiary);
    margin-left: auto;
    flex-shrink: 0;
  }

  .submenu {
    position: absolute;
    left: 100%;
    top: -6px;
    min-width: 120px;
    padding: 6px;
    background: var(--background-acrylic);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-flyout);
    animation: menuIn 100ms cubic-bezier(0, 0, 0, 1);
  }

  /* Flip submenu to the left when it would overflow the viewport */
  .submenu-wrapper.flip-left > .submenu {
    left: auto;
    right: 100%;
  }

  /* Flip submenu upward when it would overflow the bottom */
  .submenu-wrapper.flip-up > .submenu {
    top: auto;
    bottom: -6px;
  }
</style>
