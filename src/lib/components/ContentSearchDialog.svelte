<!--
  ContentSearchDialog - Ctrl+Shift+F content search using ripgrep
  Issue: tauri-explorer-evim, tauri-explorer-3a1q, tauri-explorer-en98
-->
<script lang="ts">
  import {
    startContentSearch,
    cancelContentSearch,
    openFile,
    type ContentSearchResult,
    type ContentMatch,
    type ContentSearchEvent,
  } from "$lib/api/files";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { explorer as defaultExplorer } from "$lib/state/explorer.svelte";

  interface FlattenedResult {
    filePath: string;
    relativePath: string;
    match: ContentMatch;
    isFirstInFile: boolean;
  }

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  const paneNav = getPaneNavigationContext();

  let query = $state("");
  let filterQuery = $state("");
  let caseSensitive = $state(false);
  let regexMode = $state(false);
  let results = $state<ContentSearchResult[]>([]);
  let selectedIndex = $state(0);
  let loading = $state(false);
  let inputRef = $state<HTMLInputElement | null>(null);
  let listRef = $state<HTMLUListElement | null>(null);

  // Stats
  let filesSearched = $state(0);
  let totalMatches = $state(0);

  // Streaming search state
  let activeSearchId: number | null = null;
  let unlisten: UnlistenFn | null = null;

  // Deduplication set - persists across batches, avoids O(n) rebuild
  let seenPaths = new Set<string>();

  // Virtual scroll state
  const ITEM_HEIGHT = 28;
  const FILE_HEADER_HEIGHT = 36;
  let scrollTop = $state(0);
  let containerHeight = $state(400);

  // Flatten results with filter applied
  let flattenedResults = $derived.by(() => {
    const flattened: FlattenedResult[] = [];
    const filterLower = filterQuery.toLowerCase();

    for (const file of results) {
      let isFirst = true;
      for (const match of file.matches) {
        if (filterLower && !match.lineContent.toLowerCase().includes(filterLower) &&
            !file.relativePath.toLowerCase().includes(filterLower)) {
          continue;
        }

        flattened.push({
          filePath: file.path,
          relativePath: file.relativePath,
          match,
          isFirstInFile: isFirst,
        });
        isFirst = false;
      }
    }

    return flattened;
  });

  // Compute virtual scroll window - only render visible items
  let virtualWindow = $derived.by(() => {
    const items = flattenedResults;
    if (items.length === 0) return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 };

    // Estimate total height (file headers are taller)
    let totalHeight = 0;
    const offsets: number[] = [];
    for (let i = 0; i < items.length; i++) {
      offsets.push(totalHeight);
      totalHeight += items[i].isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT;
    }

    // Find first visible item via binary search
    let lo = 0, hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid] + (items[mid].isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT) <= scrollTop) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const overscan = 10;
    const startIndex = Math.max(0, lo - overscan);

    // Find last visible item
    const viewEnd = scrollTop + containerHeight;
    let endIndex = lo;
    while (endIndex < items.length && offsets[endIndex] < viewEnd) {
      endIndex++;
    }
    endIndex = Math.min(items.length, endIndex + overscan);

    return {
      startIndex,
      endIndex,
      offsetY: offsets[startIndex] ?? 0,
      totalHeight,
    };
  });

  let visibleItems = $derived(
    flattenedResults.slice(virtualWindow.startIndex, virtualWindow.endIndex)
  );

  // Get root directory from active explorer
  function getRootPath(): string {
    const explorer = paneNav?.getActiveExplorer() ?? defaultExplorer;
    return explorer.state.currentPath;
  }

  // Cancel active search and cleanup listener
  async function cancelActiveSearch(): Promise<void> {
    if (activeSearchId !== null) {
      await cancelContentSearch(activeSearchId);
      activeSearchId = null;
    }
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  // Setup event listener for streaming search results
  async function setupSearchListener(searchId: number): Promise<void> {
    if (unlisten) {
      unlisten();
    }

    unlisten = await listen<ContentSearchEvent>("content-search-results", (event) => {
      const payload = event.payload;

      if (payload.searchId !== searchId || activeSearchId !== searchId) {
        return;
      }

      // Deduplicate using persistent set (O(batch) instead of O(total))
      const newResults = payload.results.filter(r => {
        if (seenPaths.has(r.path)) return false;
        seenPaths.add(r.path);
        return true;
      });

      if (newResults.length > 0) {
        results.push(...newResults);
      }

      filesSearched = payload.filesSearched;
      totalMatches = payload.totalMatches;

      if (selectedIndex >= flattenedResults.length) {
        selectedIndex = Math.max(0, flattenedResults.length - 1);
      }

      if (payload.done) {
        loading = false;
      }
    });
  }

  function startSearch(): void {
    if (!query.trim()) {
      return;
    }

    loading = true;
    results = [];
    seenPaths = new Set();
    selectedIndex = 0;
    filesSearched = 0;
    totalMatches = 0;
    scrollTop = 0;

    cancelActiveSearch().then(async () => {
      const root = getRootPath();
      const result = await startContentSearch(query, root, caseSensitive, regexMode, 500);

      if (result.ok) {
        activeSearchId = result.data;
        await setupSearchListener(result.data);
      } else {
        results = [];
        loading = false;
      }
    });
  }

  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (flattenedResults.length > 0) {
          selectedIndex = (selectedIndex + 1) % flattenedResults.length;
          scrollToSelected();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (flattenedResults.length > 0) {
          selectedIndex = (selectedIndex - 1 + flattenedResults.length) % flattenedResults.length;
          scrollToSelected();
        }
        break;
      case "Enter":
        event.preventDefault();
        if (event.target === inputRef) {
          startSearch();
        } else if (flattenedResults[selectedIndex]) {
          selectResult(flattenedResults[selectedIndex]);
        }
        break;
    }
  }

  function scrollToSelected(): void {
    if (!listRef) return;
    // Estimate the offset of the selected item
    let offset = 0;
    for (let i = 0; i < selectedIndex; i++) {
      offset += flattenedResults[i].isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT;
    }
    const itemH = flattenedResults[selectedIndex]?.isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT;

    // Scroll so the selected item is visible
    const container = listRef.parentElement;
    if (!container) return;
    if (offset < container.scrollTop) {
      container.scrollTop = offset;
    } else if (offset + itemH > container.scrollTop + container.clientHeight) {
      container.scrollTop = offset + itemH - container.clientHeight;
    }
  }

  async function selectResult(result: FlattenedResult): Promise<void> {
    const openResult = await openFile(result.filePath);
    if (!openResult.ok) {
      const explorer = paneNav?.getActiveExplorer() ?? defaultExplorer;
      const parentDir = result.filePath.substring(0, result.filePath.lastIndexOf("/"));
      explorer.navigateTo(parentDir);
    }
    onClose();
  }

  function highlightMatch(lineContent: string, matchStart: number, matchEnd: number): string {
    const before = escapeHtml(lineContent.slice(0, matchStart));
    const match = escapeHtml(lineContent.slice(matchStart, matchEnd));
    const after = escapeHtml(lineContent.slice(matchEnd));
    return `${before}<mark>${match}</mark>${after}`;
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function handleScroll(e: Event): void {
    const target = e.target as HTMLElement;
    scrollTop = target.scrollTop;
    containerHeight = target.clientHeight;
  }

  // Focus input when dialog opens
  $effect(() => {
    if (open && inputRef) {
      query = "";
      filterQuery = "";
      results = [];
      seenPaths = new Set();
      selectedIndex = 0;
      filesSearched = 0;
      totalMatches = 0;
      scrollTop = 0;
      setTimeout(() => inputRef?.focus(), 0);
    }
  });

  // Cleanup on close
  $effect(() => {
    if (!open) {
      cancelActiveSearch();
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="content-search-overlay" onclick={onClose} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="content-search-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="search-header">
        <div class="search-container">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="search-icon">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <input
            type="text"
            class="search-input"
            placeholder="Search in files..."
            bind:value={query}
            bind:this={inputRef}
            onkeydown={(e) => e.key === 'Enter' && startSearch()}
          />
          <div class="search-options">
            <button
              class="option-btn"
              class:active={caseSensitive}
              onclick={() => caseSensitive = !caseSensitive}
              title="Match Case (Alt+C)"
            >
              Aa
            </button>
            <button
              class="option-btn"
              class:active={regexMode}
              onclick={() => regexMode = !regexMode}
              title="Use Regex (Alt+R)"
            >
              .*
            </button>
            <button
              class="search-btn"
              onclick={startSearch}
              disabled={!query.trim() || loading}
            >
              Search
            </button>
          </div>
        </div>

        {#if results.length > 0}
          <div class="filter-container">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="filter-icon">
              <path d="M2 4H14M4 8H12M6 12H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <input
              type="text"
              class="filter-input"
              placeholder="Filter results..."
              bind:value={filterQuery}
            />
          </div>
        {/if}
      </div>

      <div class="results-container" onscroll={handleScroll}>
        {#if loading}
          <div class="search-status">
            <div class="spinner"></div>
            <span>Searching... {filesSearched.toLocaleString()} files scanned, {totalMatches.toLocaleString()} matches</span>
          </div>
        {/if}

        {#if flattenedResults.length > 0}
          <ul class="results-list" bind:this={listRef} style="height: {virtualWindow.totalHeight}px; position: relative;">
            <div style="position: absolute; top: 0; left: 0; right: 0; transform: translateY({virtualWindow.offsetY}px);">
              {#each visibleItems as result, i (result.filePath + ':' + result.match.lineNumber + ':' + result.match.column)}
                {@const globalIndex = virtualWindow.startIndex + i}
                <li
                  class="result-item"
                  class:selected={globalIndex === selectedIndex}
                  class:file-header={result.isFirstInFile}
                  role="option"
                  aria-selected={globalIndex === selectedIndex}
                  onclick={() => selectResult(result)}
                  onmouseenter={() => selectedIndex = globalIndex}
                  style="height: {result.isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT}px;"
                >
                  {#if result.isFirstInFile}
                    <div class="file-path">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="file-icon">
                        <path d="M3 2C3 1.44772 3.44772 1 4 1H9L14 6V14C14 14.5523 13.5523 15 13 15H4C3.44772 15 3 14.5523 3 14V2Z" fill="var(--accent)" fill-opacity="0.15"/>
                        <path d="M3 2C3 1.44772 3.44772 1 4 1H9L14 6V14C14 14.5523 13.5523 15 13 15H4C3.44772 15 3 14.5523 3 14V2Z" stroke="var(--accent)" stroke-width="1"/>
                        <path d="M9 1V5C9 5.55228 9.44772 6 10 6H14" stroke="var(--accent)" stroke-width="1"/>
                      </svg>
                      <span class="file-name">{result.relativePath}</span>
                    </div>
                  {/if}
                  <div class="match-row">
                    <span class="line-number">{result.match.lineNumber}</span>
                    <span class="line-content">{@html highlightMatch(result.match.lineContent, result.match.matchStart, result.match.matchEnd)}</span>
                  </div>
                </li>
              {/each}
            </div>
          </ul>
        {:else if query && !loading && results.length === 0}
          <div class="no-results">No matches found</div>
        {:else if !query}
          <div class="no-results hint">Enter a search term and press Enter or click Search</div>
        {/if}
      </div>

      <div class="footer">
        <div class="stats">
          {#if results.length > 0}
            <span>{flattenedResults.length} matches in {results.length} files</span>
          {/if}
        </div>
        <div class="shortcuts">
          <span class="shortcut"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span class="shortcut"><kbd>Enter</kbd> Open</span>
          <span class="shortcut"><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .content-search-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    z-index: 1000;
    animation: fadeIn 100ms ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .content-search-dialog {
    width: 700px;
    max-width: 90vw;
    max-height: 80vh;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    overflow: hidden;
    display: flex;
    flex-direction: column;
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

  .search-header {
    border-bottom: 1px solid var(--divider);
  }

  .search-container {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
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

  .search-options {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .option-btn {
    padding: 4px 8px;
    background: var(--subtle-fill-secondary);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: monospace;
    font-size: 12px;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .option-btn:hover {
    background: var(--subtle-fill-tertiary);
  }

  .option-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--text-on-accent);
  }

  .search-btn {
    padding: 6px 12px;
    background: var(--accent);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-on-accent);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .search-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .search-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .filter-container {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--background-card-secondary);
    border-top: 1px solid var(--divider);
  }

  .filter-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .filter-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
  }

  .filter-input::placeholder {
    color: var(--text-tertiary);
  }

  .results-container {
    flex: 1;
    overflow-y: auto;
    min-height: 200px;
    max-height: 500px;
  }

  .search-status {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    color: var(--text-secondary);
    font-size: 13px;
    background: var(--background-card-secondary);
    border-bottom: 1px solid var(--divider);
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

  .results-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  .result-item {
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    box-sizing: border-box;
    overflow: hidden;
  }

  .result-item:hover,
  .result-item.selected {
    background: var(--subtle-fill-secondary);
  }

  .result-item.selected {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .result-item.file-header {
    padding-top: 8px;
  }

  .file-path {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 2px;
  }

  .file-icon {
    flex-shrink: 0;
  }

  .file-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-item.selected .file-name {
    color: var(--text-on-accent);
  }

  .match-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    font-size: 12px;
  }

  .line-number {
    color: var(--text-tertiary);
    min-width: 40px;
    text-align: right;
    flex-shrink: 0;
  }

  .result-item.selected .line-number {
    color: var(--text-on-accent);
    opacity: 0.7;
  }

  .line-content {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
  }

  .result-item.selected .line-content {
    color: var(--text-on-accent);
  }

  .line-content :global(mark) {
    background: rgba(255, 200, 0, 0.4);
    color: inherit;
    padding: 1px 2px;
    border-radius: 2px;
  }

  .result-item.selected .line-content :global(mark) {
    background: rgba(255, 255, 255, 0.3);
  }

  .no-results {
    padding: 32px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 14px;
  }

  .no-results.hint {
    color: var(--text-tertiary);
  }

  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    background: var(--background-card-secondary);
    border-top: 1px solid var(--divider);
  }

  .stats {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .shortcuts {
    display: flex;
    gap: 16px;
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
