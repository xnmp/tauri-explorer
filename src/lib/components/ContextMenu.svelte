<!--
  Context Menu component - Windows 11 Fluent Design
  Right-click menu for file operations
  Issue: tauri-explorer-83z, tauri-explorer-1k9k
-->
<script lang="ts">
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { contextMenuStore } from "$lib/state/context-menu.svelte";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { compressToZip, extractArchive, openFile, openInTerminal } from "$lib/api/files";
  import type { FileEntry } from "$lib/domain/file";
  import type { ViewMode } from "$lib/state/types";

  interface Props {
    explorer?: ExplorerInstance;
  }

  let { explorer = defaultExplorer }: Props = $props();

  function withSelectedEntry(action: (entry: FileEntry) => void): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) {
      action(entries[0]);
    }
    contextMenuStore.close();
  }

  const hasSelection = $derived(explorer.state.selectedPaths.size > 0);

  /** Check if the single selected entry is a bookmarkable directory */
  const selectedDirectory = $derived.by((): FileEntry | null => {
    const entries = explorer.getSelectedEntries();
    if (entries.length !== 1) return null;
    return entries[0].kind === "directory" ? entries[0] : null;
  });

  const isBookmarked = $derived(
    selectedDirectory ? bookmarksStore.hasBookmark(selectedDirectory.path) : false
  );

  function handleCut(): void {
    const selected = explorer.getSelectedEntries();
    if (selected.length > 0) explorer.cutToClipboard(selected);
  }

  function handleCopy(): void {
    const selected = explorer.getSelectedEntries();
    if (selected.length > 0) explorer.copyToClipboard(selected);
  }

  async function handlePaste(): Promise<void> {
    await explorer.paste();
    contextMenuStore.close();
  }

  function handleRename(): void {
    withSelectedEntry((entry) => explorer.startRename(entry));
  }

  function handleDelete(): void {
    const entries = explorer.getSelectedEntries();
    if (entries.length > 0) {
      explorer.startDelete(entries);
    }
    contextMenuStore.close();
  }

  function handleNewFolder(): void {
    explorer.openNewFolderDialog();
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
    await extractArchive(selectedArchive.path, true);
    explorer.refresh();
    contextMenuStore.close();
  }

  async function handleExtractToFolder(): Promise<void> {
    if (!selectedArchive) return;
    await extractArchive(selectedArchive.path, false);
    explorer.refresh();
    contextMenuStore.close();
  }

  async function handleCompress(): Promise<void> {
    const selected = explorer.getSelectedEntries();
    if (selected.length === 0) return;
    await compressToZip(selected.map((e) => e.path));
    explorer.refresh();
    contextMenuStore.close();
  }

  /** The single selected file (not directory) for Open With */
  const selectedFile = $derived.by((): FileEntry | null => {
    const entries = explorer.getSelectedEntries();
    if (entries.length !== 1 || entries[0].kind !== "file") return null;
    return entries[0];
  });

  async function handleOpenDefault(): Promise<void> {
    if (!selectedFile) return;
    await openFile(selectedFile.path);
    contextMenuStore.close();
  }

  async function handleOpenInTerminal(): Promise<void> {
    const path = selectedDirectory?.path ?? explorer.state.currentPath;
    await openInTerminal(path, settingsStore.terminalApp);
    contextMenuStore.close();
  }

  const viewModes: { id: ViewMode; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "list", label: "List" },
    { id: "tiles", label: "Tiles" },
  ];
</script>

<svelte:window on:keydown={handleKeydown} />

{#if contextMenuStore.isOpen && contextMenuStore.position}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="context-menu-backdrop" onclick={() => contextMenuStore.close()}></div>

  <div
    class="context-menu"
    style="left: {contextMenuStore.position.x}px; top: {contextMenuStore.position.y}px;"
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

      <div class="menu-divider"></div>
    {/if}

    <!-- Always available options -->
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
      <button
        class="menu-item"
        class:selected={explorer.state.viewMode === mode.id}
        onclick={() => handleSetViewMode(mode.id)}
        role="menuitemradio"
        aria-checked={explorer.state.viewMode === mode.id}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {#if mode.id === "details"}
            <path d="M2 4H14M2 8H14M2 12H14" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          {:else if mode.id === "list"}
            <path d="M3 4H4M6 4H13M3 8H4M6 8H13M3 12H4M6 12H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          {:else}
            <rect x="2" y="2" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
            <rect x="9" y="2" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
            <rect x="2" y="9" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
            <rect x="9" y="9" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
          {/if}
        </svg>
        <span>{mode.label}</span>
        {#if explorer.state.viewMode === mode.id}
          <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .context-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 999;
  }

  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 200px;
    padding: 4px;
    background: var(--background-acrylic);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-md);
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
    padding: 8px 12px;
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
    padding: 6px 12px 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .menu-item.selected {
    background: var(--subtle-fill-tertiary);
  }

  .check-icon {
    color: var(--accent);
    margin-left: auto;
  }
</style>
