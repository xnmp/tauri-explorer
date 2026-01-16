<!--
  QuickOpen component - VSCode-style Ctrl+P file search
  Issue: tauri-explorer-w3t, tauri-explorer-btz, tauri-explorer-az6w
-->
<script lang="ts">
  import {
    startStreamingSearch,
    cancelSearch,
    openFile,
    type SearchResult,
    type SearchResultsEvent,
  } from "$lib/api/files";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { explorer as defaultExplorer } from "$lib/state/explorer.svelte";
  import { getFileIconColor, getFileIconCategory, type IconCategory } from "$lib/domain/file-types";
  import type { FileEntry } from "$lib/domain/file";

  // Helper to convert SearchResult to FileEntry-like object for icon functions
  function toFileEntry(result: SearchResult): FileEntry {
    return {
      name: result.name,
      path: result.path,
      kind: result.kind,
      size: 0,
      modified: "",
    };
  }

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  const paneNav = getPaneNavigationContext();

  let query = $state("");
  let results = $state<SearchResult[]>([]);
  let selectedIndex = $state(0);
  let loading = $state(false);
  let inputRef = $state<HTMLInputElement | null>(null);

  // Debounce timer for search
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Streaming search state
  let activeSearchId: number | null = null;
  let unlisten: UnlistenFn | null = null;
  let totalScanned = $state(0);

  // Get root directory from active explorer
  function getRootPath(): string {
    const explorer = paneNav?.getActiveExplorer() ?? defaultExplorer;
    return explorer.state.currentPath;
  }

  // Cancel active search and cleanup listener
  async function cancelActiveSearch(): Promise<void> {
    if (activeSearchId !== null) {
      await cancelSearch(activeSearchId);
      activeSearchId = null;
    }
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  // Setup event listener for streaming search results
  async function setupSearchListener(searchId: number): Promise<void> {
    // Clean up any existing listener
    if (unlisten) {
      unlisten();
    }

    unlisten = await listen<SearchResultsEvent>("search-results", (event) => {
      const payload = event.payload;

      // Only handle events for our active search
      if (payload.searchId !== searchId || activeSearchId !== searchId) {
        return;
      }

      // Update results with latest batch
      results = payload.results;
      totalScanned = payload.totalScanned;

      // Reset selection if needed
      if (selectedIndex >= results.length) {
        selectedIndex = Math.max(0, results.length - 1);
      }

      // Stop loading when search is done
      if (payload.done) {
        loading = false;
      }
    });
  }

  // Debounced streaming search
  function handleInput(): void {
    if (searchTimer) clearTimeout(searchTimer);

    if (!query.trim()) {
      cancelActiveSearch();
      results = [];
      selectedIndex = 0;
      totalScanned = 0;
      loading = false;
      return;
    }

    loading = true;
    searchTimer = setTimeout(async () => {
      // Cancel any previous search
      await cancelActiveSearch();

      const root = getRootPath();
      const result = await startStreamingSearch(query, root, 20);

      if (result.ok) {
        activeSearchId = result.data;
        await setupSearchListener(result.data);
      } else {
        results = [];
        loading = false;
      }
    }, 50); // Shorter debounce for streaming - results come in progressively
  }

  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (results.length > 0) {
          selectedIndex = (selectedIndex + 1) % results.length;
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (results.length > 0) {
          selectedIndex = (selectedIndex - 1 + results.length) % results.length;
        }
        break;
      case "Enter":
        event.preventDefault();
        if (results[selectedIndex]) {
          selectResult(results[selectedIndex]);
        }
        break;
    }
  }

  async function selectResult(result: SearchResult): Promise<void> {
    const explorer = paneNav?.getActiveExplorer() ?? defaultExplorer;

    if (result.kind === "directory") {
      // Navigate to the directory
      explorer.navigateTo(result.path);
    } else {
      // Try to open the file
      const openResult = await openFile(result.path);
      if (!openResult.ok) {
        // If can't open (might be a special file), navigate to its parent directory
        const parentDir = result.path.substring(0, result.path.lastIndexOf("/"));
        explorer.navigateTo(parentDir);
      }
    }

    onClose();
  }

  // Focus input when dialog opens
  $effect(() => {
    if (open && inputRef) {
      query = "";
      results = [];
      selectedIndex = 0;
      setTimeout(() => inputRef?.focus(), 0);
    }
  });

  // Cleanup on close
  $effect(() => {
    if (!open) {
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      // Cancel any active streaming search
      cancelActiveSearch();
      totalScanned = 0;
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="quick-open-overlay" onclick={onClose} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="quick-open-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="search-container">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="search-icon">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <input
          type="text"
          class="search-input"
          placeholder="Search files..."
          bind:value={query}
          bind:this={inputRef}
          oninput={handleInput}
        />
        {#if loading}
          <div class="search-status">
            {#if totalScanned > 0}
              <span class="scanned-count">{totalScanned.toLocaleString()} scanned</span>
            {/if}
            <div class="spinner"></div>
          </div>
        {/if}
      </div>

      <div class="results-container">
        {#if results.length > 0}
          <ul class="results-list" role="listbox">
            {#each results as result, index (result.path)}
              <li
                class="result-item"
                class:selected={index === selectedIndex}
                class:is-directory={result.kind === "directory"}
                role="option"
                aria-selected={index === selectedIndex}
                onclick={() => selectResult(result)}
                onmouseenter={() => selectedIndex = index}
              >
                {#if result.kind === "directory"}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="folder-icon">
                    <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="#FFB900"/>
                  </svg>
                {:else}
                  {@const entry = toFileEntry(result)}
                  {@const iconColor = getFileIconColor(entry)}
                  {@const iconCategory = getFileIconCategory(entry)}
                  {#if iconCategory === "image"}
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="file-icon">
                      <rect x="2" y="2" width="12" height="12" rx="1.5" fill={iconColor} fill-opacity="0.15"/>
                      <rect x="2" y="2" width="12" height="12" rx="1.5" stroke={iconColor} stroke-width="1"/>
                      <circle cx="5.5" cy="5.5" r="1.25" fill={iconColor}/>
                      <path d="M2 11L5 8L7.5 10.5L10 7L14 11V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V11Z" fill={iconColor} fill-opacity="0.4"/>
                    </svg>
                  {:else if iconCategory === "archive"}
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="file-icon">
                      <path d="M3 2C3 1.44772 3.44772 1 4 1H12C12.5523 1 13 1.44772 13 2V14C13 14.5523 12.5523 15 12 15H4C3.44772 15 3 14.5523 3 14V2Z" fill={iconColor} fill-opacity="0.15"/>
                      <path d="M3 2C3 1.44772 3.44772 1 4 1H12C12.5523 1 13 1.44772 13 2V14C13 14.5523 12.5523 15 12 15H4C3.44772 15 3 14.5523 3 14V2Z" stroke={iconColor} stroke-width="1"/>
                      <rect x="6" y="3" width="4" height="2" rx="0.5" fill={iconColor}/>
                      <rect x="6" y="6" width="4" height="2" rx="0.5" fill={iconColor}/>
                      <rect x="6" y="9" width="4" height="3" rx="0.5" fill={iconColor}/>
                    </svg>
                  {:else if iconCategory === "code"}
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="file-icon">
                      <path d="M3 2C3 1.44772 3.44772 1 4 1H9L13 5V14C13 14.5523 12.5523 15 12 15H4C3.44772 15 3 14.5523 3 14V2Z" fill={iconColor} fill-opacity="0.15"/>
                      <path d="M3 2C3 1.44772 3.44772 1 4 1H9L13 5V14C13 14.5523 12.5523 15 12 15H4C3.44772 15 3 14.5523 3 14V2Z" stroke={iconColor} stroke-width="1"/>
                      <path d="M9 1V4C9 4.55228 9.44772 5 10 5H13" stroke={iconColor} stroke-width="1"/>
                      <path d="M6 8L4.5 9.5L6 11M10 8L11.5 9.5L10 11" stroke={iconColor} stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {:else if iconCategory === "media"}
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="file-icon">
                      <rect x="2" y="3" width="12" height="10" rx="1.5" fill={iconColor} fill-opacity="0.15"/>
                      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke={iconColor} stroke-width="1"/>
                      <path d="M6 6V10L10 8L6 6Z" fill={iconColor}/>
                    </svg>
                  {:else if iconCategory === "executable"}
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="file-icon">
                      <rect x="2" y="2" width="12" height="12" rx="2" fill={iconColor} fill-opacity="0.15"/>
                      <rect x="2" y="2" width="12" height="12" rx="2" stroke={iconColor} stroke-width="1"/>
                      <path d="M5 8H11M8 5V11" stroke={iconColor} stroke-width="1.25" stroke-linecap="round"/>
                    </svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="file-icon">
                      <path d="M3 2C3 1.44772 3.44772 1 4 1H9L14 6V14C14 14.5523 13.5523 15 13 15H4C3.44772 15 3 14.5523 3 14V2Z" fill={iconColor} fill-opacity="0.15"/>
                      <path d="M3 2C3 1.44772 3.44772 1 4 1H9L14 6V14C14 14.5523 13.5523 15 13 15H4C3.44772 15 3 14.5523 3 14V2Z" stroke={iconColor} stroke-width="1"/>
                      <path d="M9 1V5C9 5.55228 9.44772 6 10 6H14" stroke={iconColor} stroke-width="1"/>
                      <path d="M5.5 9H10.5M5.5 11.5H9" stroke={iconColor} stroke-width="0.75" stroke-linecap="round"/>
                    </svg>
                  {/if}
                {/if}
                <div class="result-content">
                  <span class="result-name">{result.name}</span>
                  <span class="result-path">{result.relativePath}</span>
                </div>
                {#if result.kind === "directory"}
                  <span class="result-kind">folder</span>
                {:else}
                  <span class="result-score">{Math.round(result.score)}%</span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else if query && !loading}
          <div class="no-results">No matching files found</div>
        {:else if !query}
          <div class="no-results hint">Start typing to search files...</div>
        {/if}
      </div>

      <div class="footer">
        <span class="shortcut"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span class="shortcut"><kbd>Enter</kbd> Open</span>
        <span class="shortcut"><kbd>Esc</kbd> Close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .quick-open-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
    z-index: 1000;
    animation: fadeIn 100ms ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .quick-open-dialog {
    width: 600px;
    max-width: 90vw;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    overflow: hidden;
    animation: slideDown 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-20px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .search-container {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--divider);
  }

  .search-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 16px;
    color: var(--text-primary);
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .search-status {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .scanned-count {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .results-container {
    max-height: 400px;
    overflow-y: auto;
  }

  .results-list {
    list-style: none;
    margin: 0;
    padding: 8px;
  }

  .result-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .result-item:hover,
  .result-item.selected {
    background: var(--subtle-fill-secondary);
  }

  .result-item.selected {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .result-item.selected .result-path,
  .result-item.selected .result-score {
    color: var(--text-on-accent);
    opacity: 0.8;
  }

  .file-icon,
  .folder-icon {
    flex-shrink: 0;
  }

  /* When selected, make file icons use white with transparency */
  .result-item.selected .file-icon {
    filter: brightness(0) invert(1);
    opacity: 0.9;
  }

  .result-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .result-name {
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-path {
    font-size: 12px;
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-score,
  .result-kind {
    font-size: 11px;
    color: var(--text-tertiary);
    padding: 2px 6px;
    background: var(--subtle-fill-secondary);
    border-radius: 4px;
    flex-shrink: 0;
  }

  .result-kind {
    color: #B38F00;
    background: rgba(255, 185, 0, 0.15);
  }

  .result-item.selected .result-score,
  .result-item.selected .result-kind {
    background: rgba(255, 255, 255, 0.2);
  }

  .result-item.is-directory {
    border-left: 2px solid #FFB900;
    padding-left: 10px;
  }

  .result-item.selected.is-directory {
    border-left-color: rgba(255, 255, 255, 0.5);
  }

  .no-results {
    padding: 24px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 14px;
  }

  .no-results.hint {
    color: var(--text-tertiary);
  }

  .footer {
    display: flex;
    gap: 16px;
    padding: 10px 16px;
    background: var(--background-card-secondary);
    border-top: 1px solid var(--divider);
  }

  .shortcut {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-tertiary);
  }

  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    background: var(--subtle-fill-tertiary);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    color: var(--text-secondary);
  }
</style>
