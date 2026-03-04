<!--
  NavigationBar component - Pane-specific navigation + breadcrumbs
  Contains back/forward/up/refresh buttons and breadcrumbs for each pane.
  Issue: tauri-u00y, tauri-nxfi
-->
<script lang="ts">
  import { tick, onMount } from "svelte";
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { fetchDirectory, getHomeDirectory } from "$lib/api/files";
  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer?: ExplorerInstance;
  }

  let { explorer = defaultExplorer }: Props = $props();

  // Home directory detection for breadcrumb collapsing
  let homeDir = $state<string | null>(null);

  onMount(async () => {
    const result = await getHomeDirectory();
    if (result.ok) homeDir = result.data;
  });

  const homeParts = $derived(homeDir ? homeDir.split("/").filter(Boolean) : []);

  const isUnderHome = $derived.by(() => {
    const crumbs = explorer.breadcrumbs;
    if (!homeDir || crumbs.length === 0) return false;
    return crumbs.length >= homeParts.length &&
      crumbs[homeParts.length - 1]?.path === homeDir;
  });

  const visibleBreadcrumbs = $derived(
    isUnderHome ? explorer.breadcrumbs.slice(homeParts.length) : explorer.breadcrumbs
  );

  let editingPath = $state(false);
  let editedPath = $state("");
  let pathInputRef: HTMLInputElement | null = null;

  // Autocomplete state
  let suggestions = $state<FileEntry[]>([]);
  let selectedIndex = $state(-1);
  let showSuggestions = $state(false);
  let fetchGeneration = 0; // Discard stale fetches

  // Caret picker state - shows subdirectories when clicking a breadcrumb separator
  let caretPickerPath = $state<string | null>(null);
  let caretPickerDirs = $state<FileEntry[]>([]);
  let caretPickerEl = $state<HTMLElement | null>(null);

  async function openCaretPicker(parentPath: string, el: HTMLElement) {
    if (caretPickerPath === parentPath) {
      closeCaretPicker();
      return;
    }
    caretPickerPath = parentPath;
    caretPickerEl = el;
    caretPickerDirs = [];
    const result = await fetchDirectory(parentPath);
    if (result.ok && caretPickerPath === parentPath) {
      caretPickerDirs = result.data.entries.filter((e) => e.kind === "directory");
    }
  }

  function closeCaretPicker() {
    caretPickerPath = null;
    caretPickerDirs = [];
    caretPickerEl = null;
  }

  function navigateFromCaret(path: string) {
    closeCaretPicker();
    explorer.navigateTo(path);
  }

  function startPathEdit() {
    editedPath = explorer.currentPath;
    editingPath = true;
    suggestions = [];
    showSuggestions = false;
    selectedIndex = -1;
    tick().then(() => pathInputRef?.select());
  }

  function cancelPathEdit() {
    editingPath = false;
    editedPath = "";
    suggestions = [];
    showSuggestions = false;
  }

  function confirmPathEdit() {
    if (editedPath.trim()) {
      explorer.navigateTo(editedPath.trim());
    }
    editingPath = false;
    editedPath = "";
    suggestions = [];
    showSuggestions = false;
  }

  /** Parse typed path into parent directory and name prefix */
  function parsePathInput(input: string): { parentDir: string; prefix: string } {
    if (!input || input === "/") return { parentDir: "/", prefix: "" };
    // If path ends with /, list contents of that directory
    if (input.endsWith("/")) return { parentDir: input, prefix: "" };
    const lastSlash = input.lastIndexOf("/");
    if (lastSlash < 0) return { parentDir: "/", prefix: input };
    return {
      parentDir: input.substring(0, lastSlash + 1),
      prefix: input.substring(lastSlash + 1),
    };
  }

  /** Fetch autocomplete suggestions for the current input */
  async function fetchSuggestions(): Promise<void> {
    const gen = ++fetchGeneration;
    const { parentDir, prefix } = parsePathInput(editedPath);

    const result = await fetchDirectory(parentDir);
    if (gen !== fetchGeneration) return; // Stale

    if (!result.ok) {
      suggestions = [];
      showSuggestions = false;
      return;
    }

    const lowerPrefix = prefix.toLowerCase();
    // Filter entries matching prefix, directories first
    const filtered = result.data.entries
      .filter((e) => e.name.toLowerCase().startsWith(lowerPrefix))
      .sort((a, b) => {
        // Directories before files
        if (a.kind === "directory" && b.kind !== "directory") return -1;
        if (a.kind !== "directory" && b.kind === "directory") return 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 12);

    suggestions = filtered;
    selectedIndex = -1;
    showSuggestions = filtered.length > 0;
  }

  /** Apply a suggestion to the input */
  function applySuggestion(entry: FileEntry): void {
    editedPath = entry.path + (entry.kind === "directory" ? "/" : "");
    suggestions = [];
    showSuggestions = false;
    selectedIndex = -1;
    // If it's a directory, fetch next level
    if (entry.kind === "directory") {
      fetchSuggestions();
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleInput(): void {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fetchSuggestions, 150);
  }

  function handlePathKeydown(event: KeyboardEvent) {
    if (showSuggestions && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedIndex = (selectedIndex + 1) % suggestions.length;
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedIndex = selectedIndex <= 0 ? suggestions.length - 1 : selectedIndex - 1;
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const target = selectedIndex >= 0 ? suggestions[selectedIndex] : suggestions[0];
        if (target) applySuggestion(target);
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (showSuggestions && selectedIndex >= 0) {
        applySuggestion(suggestions[selectedIndex]);
      } else {
        confirmPathEdit();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (showSuggestions) {
        suggestions = [];
        showSuggestions = false;
      } else {
        cancelPathEdit();
      }
    }
  }

  function handleBlur(event: FocusEvent) {
    // Don't cancel if clicking a suggestion
    const related = event.relatedTarget as HTMLElement | null;
    if (related?.closest(".suggestions-dropdown")) return;
    cancelPathEdit();
  }

  function copyPathToClipboard() {
    navigator.clipboard.writeText(explorer.currentPath);
  }
</script>

<div class="navigation-bar">
  <!-- Navigation controls next to address bar -->
  <div class="nav-controls">
    {#if settingsStore.navBarButtons.back}
      <button
        class="nav-btn"
        title="Back (Alt+Left)"
        disabled={!explorer.canGoBack}
        onclick={() => explorer.goBack()}
        aria-label="Go back"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 13L5 8L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}

    {#if settingsStore.navBarButtons.forward}
      <button
        class="nav-btn"
        title="Forward (Alt+Right)"
        disabled={!explorer.canGoForward}
        onclick={() => explorer.goForward()}
        aria-label="Go forward"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}

    {#if settingsStore.navBarButtons.up}
      <button
        class="nav-btn"
        onclick={() => explorer.goUp()}
        title="Up (Alt+Up)"
        aria-label="Go up one level"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 13V4M8 4L4 8M8 4L12 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}

    {#if settingsStore.navBarButtons.refresh}
      <button
        class="nav-btn"
        onclick={() => explorer.refresh()}
        title="Refresh (F5)"
        aria-label="Refresh"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M13.5 8C13.5 10.7614 11.2614 13 8.5 13C5.73858 13 3.5 10.7614 3.5 8C3.5 5.23858 5.73858 3 8.5 3C10.5 3 12.2 4.2 13 5.8M13 3V5.8M13 5.8H10.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="breadcrumbs-container" class:editing={editingPath} onclick={editingPath ? undefined : startPathEdit}>
    {#if editingPath}
      <!-- Editable path input with autocomplete -->
      <input
        type="text"
        class="path-input"
        bind:value={editedPath}
        bind:this={pathInputRef}
        onkeydown={handlePathKeydown}
        oninput={handleInput}
        onblur={handleBlur}
        placeholder="Enter path..."
        autocomplete="off"
        spellcheck="false"
      />
      {#if showSuggestions && suggestions.length > 0}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="suggestions-dropdown" onmousedown={(e) => e.preventDefault()}>
          {#each suggestions as entry, i (entry.path)}
            <button
              class="suggestion-item"
              class:selected={i === selectedIndex}
              class:directory={entry.kind === "directory"}
              onmousedown={() => applySuggestion(entry)}
              onmouseenter={() => { selectedIndex = i; }}
            >
              <span class="suggestion-icon">
                {#if entry.kind === "directory"}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M3 3.5C3 2.67 3.67 2 4.5 2H7L8.5 3.5H12.5C13.33 3.5 14 4.17 14 5V12C14 12.83 13.33 13.5 12.5 13.5H4.5C3.67 13.5 3 12.83 3 12V3.5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
                  </svg>
                {:else}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M4 2H10L13 5V13C13 13.55 12.55 14 12 14H4C3.45 14 3 13.55 3 13V3C3 2.45 3.45 2 4 2Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
                    <path d="M10 2V5H13" stroke="currentColor" stroke-width="1.2"/>
                  </svg>
                {/if}
              </span>
              <span class="suggestion-name">{entry.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <!-- Breadcrumb view -->
      {#if isUnderHome}
        <!-- Home icon: navigates to user's home directory -->
        <button class="crumb root" onclick={(e) => { e.stopPropagation(); explorer.navigateTo(homeDir!); }} aria-label="Home folder">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 1.5L14.5 7V14C14.5 14.2761 14.2761 14.5 14 14.5H10V10C10 9.72386 9.77614 9.5 9.5 9.5H6.5C6.22386 9.5 6 9.72386 6 10V14.5H2C1.72386 14.5 1.5 14.2761 1.5 14V7L8 1.5Z"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {:else}
        <!-- Root folder icon -->
        <button class="crumb root" onclick={(e) => { e.stopPropagation(); explorer.navigateTo("/"); }} aria-label="Root">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 3.5C3 2.67 3.67 2 4.5 2H7L8.5 3.5H12.5C13.33 3.5 14 4.17 14 5V12C14 12.83 13.33 13.5 12.5 13.5H4.5C3.67 13.5 3 12.83 3 12V3.5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
          </svg>
        </button>
      {/if}

      {#each visibleBreadcrumbs as segment, i (segment.path)}
        {@const parentOfSegment = i === 0 ? (isUnderHome ? homeDir! : "/") : visibleBreadcrumbs[i - 1].path}
        <button
          class="separator caret-btn"
          class:caret-active={caretPickerPath === parentOfSegment}
          aria-label="Show folders in {i === 0 ? 'parent' : visibleBreadcrumbs[i - 1].name}"
          onclick={(e) => { e.stopPropagation(); openCaretPicker(parentOfSegment, e.currentTarget as HTMLElement); }}
        >
          <svg class="chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 2L6 5L3 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          class="crumb"
          class:current={i === visibleBreadcrumbs.length - 1}
          onclick={(e) => { e.stopPropagation(); explorer.navigateTo(segment.path); }}
        >
          {segment.name}
        </button>
      {/each}

      {#if caretPickerPath && caretPickerDirs.length > 0}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="caret-picker-backdrop" onclick={closeCaretPicker} onkeydown={(e) => { if (e.key === "Escape") closeCaretPicker(); }}></div>
        <div class="caret-picker" style="left: {caretPickerEl ? caretPickerEl.getBoundingClientRect().left : 0}px; top: {caretPickerEl ? caretPickerEl.getBoundingClientRect().bottom + 4 : 0}px;">
          {#each caretPickerDirs as dir (dir.path)}
            <button class="caret-picker-item" onclick={() => navigateFromCaret(dir.path)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 3.5C3 2.67 3.67 2 4.5 2H7L8.5 3.5H12.5C13.33 3.5 14 4.17 14 5V12C14 12.83 13.33 13.5 12.5 13.5H4.5C3.67 13.5 3 12.83 3 12V3.5Z" fill="var(--icon-folder, #ffb900)" opacity="0.8"/>
              </svg>
              {dir.name}
            </button>
          {/each}
        </div>
      {/if}

      <button class="dropdown-toggle" onclick={(e) => { e.stopPropagation(); copyPathToClipboard(); }} title="Copy path to clipboard" aria-label="Copy path">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="4" y="4" width="6" height="7" rx="1" stroke="currentColor" stroke-width="1"/>
          <path d="M8 4V2.5C8 2.22386 7.77614 2 7.5 2H3C2.72386 2 2.5 2.22386 2.5 2.5V8C2.5 8.27614 2.72386 8.5 3 8.5H4" stroke="currentColor" stroke-width="1"/>
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .navigation-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--background-card-secondary);
    border-bottom: 1px solid var(--divider);
    height: 36px;
  }

  .nav-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .nav-btn:hover:not(:disabled) {
    background: var(--subtle-fill-secondary);
  }

  .nav-btn:active:not(:disabled) {
    background: var(--subtle-fill-tertiary);
    transform: scale(0.96);
  }

  .nav-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .nav-btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }

  .breadcrumbs-container {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }

  .breadcrumbs-container.editing {
    overflow: visible;
  }

  .breadcrumbs-container:focus-within {
    border-color: var(--accent);
    background: var(--control-fill-secondary);
  }

  .breadcrumbs-container:not(.editing) {
    cursor: text;
  }

  .breadcrumbs-container:not(.editing):hover {
    background: var(--control-fill-secondary);
  }

  .path-input {
    flex: 1;
    height: 100%;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
    padding: 0;
  }

  .path-input::placeholder {
    color: var(--text-tertiary);
  }

  .crumb {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    background: var(--breadcrumb-segment-bg, transparent);
    border: none;
    border-radius: 3px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .crumb.root {
    padding: 2px 3px;
    color: var(--text-tertiary);
  }

  .crumb:hover {
    background: var(--breadcrumb-segment-bg-hover, var(--subtle-fill-secondary));
  }

  .crumb:active {
    background: var(--subtle-fill-tertiary);
  }

  .crumb.current {
    font-weight: 500;
  }

  /* Separator / caret button */
  .separator {
    display: flex;
    align-items: center;
    color: var(--breadcrumb-separator-color, var(--text-tertiary));
    flex-shrink: 0;
  }

  .caret-btn {
    padding: 2px 4px;
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .caret-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .caret-btn.caret-active {
    background: var(--subtle-fill-tertiary);
    color: var(--text-primary);
  }

  /* Default: show chevron, hide powerline */
  .separator .chevron-icon {
    display: var(--breadcrumb-chevron-display, flex);
  }

  .separator .powerline-icon {
    display: var(--breadcrumb-powerline-display, none);
    height: 20px;
    width: 8px;
  }

  /* Caret picker dropdown */
  .caret-picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .caret-picker {
    position: fixed;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: 6px;
    box-shadow: var(--shadow-flyout, 0 4px 16px rgba(0, 0, 0, 0.15));
    max-height: 300px;
    min-width: 180px;
    overflow-y: auto;
    z-index: 100;
    padding: 4px;
  }

  .caret-picker-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .caret-picker-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .dropdown-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background var(--transition-fast);
    flex-shrink: 0;
    margin-left: auto;
  }

  .dropdown-toggle:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  /* Autocomplete suggestions dropdown */
  .suggestions-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 2px;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    max-height: 240px;
    overflow-y: auto;
    z-index: 100;
    padding: 4px;
  }

  .suggestion-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .suggestion-item:hover,
  .suggestion-item.selected {
    background: var(--subtle-fill-secondary);
  }

  .suggestion-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .suggestion-item.directory .suggestion-icon {
    color: var(--accent);
  }

  .suggestion-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
