<!--
  ContentSearchDialog - Ctrl+Shift+F content search using ripgrep
  Issue: tauri-explorer-evim, tauri-explorer-3a1q, tauri-explorer-en98, tauri-nczo
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
    isShowMore?: boolean;
    hiddenCount?: number;
    totalFileMatches?: number;
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
  const ITEM_HEIGHT = 30;
  const FILE_HEADER_HEIGHT = 54;
  let scrollTop = $state(0);
  let containerHeight = $state(400);

  // Pagination constants
  const PAGE_SIZE = 200;
  const COLLAPSED_LIMIT = 5;

  // Track which files the user has expanded (show all matches)
  let expandedFiles = $state<Set<string>>(new Set());

  // Non-reactive backing store for all flattened results (appended to incrementally)
  let allFlattened: FlattenedResult[] = [];

  // Reactive page slice -- only this triggers UI updates
  let flattenedResults = $state<FlattenedResult[]>([]);
  let pageEnd = $state(PAGE_SIZE);
  let totalFlattenedCount = $state(0);

  // Flatten a file's matches, respecting collapsed limit
  function flattenFile(file: ContentSearchResult, filterLower: string, isFirstFile: boolean): FlattenedResult[] {
    const isExpanded = expandedFiles.has(file.path);
    const filtered: ContentMatch[] = [];
    for (const match of file.matches) {
      if (filterLower && !match.lineContent.toLowerCase().includes(filterLower) &&
          !file.relativePath.toLowerCase().includes(filterLower)) {
        continue;
      }
      filtered.push(match);
    }
    if (filtered.length === 0) return [];

    const limit = isExpanded ? filtered.length : Math.min(COLLAPSED_LIMIT, filtered.length);
    const items: FlattenedResult[] = [];
    for (let i = 0; i < limit; i++) {
      items.push({
        filePath: file.path,
        relativePath: file.relativePath,
        match: filtered[i],
        isFirstInFile: i === 0 && isFirstFile,
        totalFileMatches: filtered.length,
      });
    }

    // Add "show more" row if collapsed and there are hidden matches
    if (!isExpanded && filtered.length > COLLAPSED_LIMIT) {
      items.push({
        filePath: file.path,
        relativePath: file.relativePath,
        match: filtered[0], // placeholder, not rendered
        isFirstInFile: false,
        isShowMore: true,
        hiddenCount: filtered.length - COLLAPSED_LIMIT,
        totalFileMatches: filtered.length,
      });
    }
    return items;
  }

  // Flatten a single batch of new results (O(batch) not O(total))
  // newResults are already deduped -- each file here is new, so first match is always isFirstInFile
  function flattenBatch(newResults: ContentSearchResult[], filterLower: string): FlattenedResult[] {
    const batch: FlattenedResult[] = [];
    for (const file of newResults) {
      batch.push(...flattenFile(file, filterLower, true));
    }
    return batch;
  }

  // Rebuild allFlattened from scratch (used when filter changes or expand/collapse toggles)
  function rebuildFlattened(filterLower: string): void {
    const rebuilt: FlattenedResult[] = [];
    for (const file of results) {
      rebuilt.push(...flattenFile(file, filterLower, true));
    }
    allFlattened = rebuilt;
    totalFlattenedCount = allFlattened.length;
    pageEnd = PAGE_SIZE;
    updatePage();
  }

  function toggleFileExpanded(filePath: string): void {
    const next = new Set(expandedFiles);
    if (next.has(filePath)) {
      next.delete(filePath);
    } else {
      next.add(filePath);
    }
    expandedFiles = next;
    rebuildFlattened(filterQuery.toLowerCase());
  }

  function updatePage(): void {
    flattenedResults = allFlattened.slice(0, pageEnd);
  }

  function resetSearchState(): void {
    query = "";
    filterQuery = "";
    prevFilter = "";
    results = [];
    allFlattened = [];
    flattenedResults = [];
    seenPaths = new Set();
    expandedFiles = new Set();
    selectedIndex = 0;
    pageEnd = PAGE_SIZE;
    totalFlattenedCount = 0;
    filesSearched = 0;
    totalMatches = 0;
    scrollTop = 0;
    loading = false;
  }

  // React to filter changes by rebuilding
  let prevFilter = "";
  $effect(() => {
    const f = filterQuery;
    if (f !== prevFilter) {
      prevFilter = f;
      rebuildFlattened(f.toLowerCase());
    }
  });

  // Cached offsets array -- recomputed only when flattenedResults changes, not on scroll
  let cachedOffsets = $derived.by(() => {
    const items = flattenedResults;
    const offsets: number[] = new Array(items.length);
    let cumulative = 0;
    for (let i = 0; i < items.length; i++) {
      offsets[i] = cumulative;
      cumulative += items[i].isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT;
    }
    return { offsets, totalHeight: cumulative };
  });

  // Compute virtual scroll window using cached offsets
  let virtualWindow = $derived.by(() => {
    const items = flattenedResults;
    const { offsets, totalHeight } = cachedOffsets;
    if (items.length === 0) return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 };

    // Binary search for first visible item
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

        // Incremental flatten: only process new batch, append to backing store
        const filterLower = filterQuery.toLowerCase();
        const batch = flattenBatch(newResults, filterLower);
        if (batch.length > 0) {
          allFlattened.push(...batch);
          totalFlattenedCount = allFlattened.length;
          updatePage();
        }
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

    const currentQuery = query;
    const currentFilter = filterQuery;
    resetSearchState();
    query = currentQuery;
    filterQuery = currentFilter;
    prevFilter = currentFilter;
    loading = true;

    cancelActiveSearch().then(async () => {
      const root = getRootPath();
      const result = await startContentSearch(query, root, caseSensitive, regexMode, 2000);

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
          const selected = flattenedResults[selectedIndex];
          if (selected.isShowMore) {
            toggleFileExpanded(selected.filePath);
          } else {
            selectResult(selected);
          }
        }
        break;
    }
  }

  function scrollToSelected(): void {
    if (!listRef) return;
    const { offsets } = cachedOffsets;
    if (selectedIndex >= offsets.length) return;

    // O(1) offset lookup via cached array
    const offset = offsets[selectedIndex];
    const itemH = flattenedResults[selectedIndex]?.isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT;

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

    // Infinite scroll: load next page when near bottom
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 100) {
      if (pageEnd < allFlattened.length) {
        pageEnd = Math.min(pageEnd + PAGE_SIZE, allFlattened.length);
        updatePage();
      }
    }
  }

  // Focus input when dialog opens
  $effect(() => {
    if (open && inputRef) {
      resetSearchState();
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
              {#each visibleItems as result, i (result.filePath + ':' + (result.isShowMore ? 'more' : result.match.lineNumber + ':' + result.match.column))}
                {@const globalIndex = virtualWindow.startIndex + i}
                {#if result.isShowMore}
                  <li
                    class="result-item show-more-row"
                    class:selected={globalIndex === selectedIndex}
                    role="option"
                    aria-selected={globalIndex === selectedIndex}
                    onclick={() => toggleFileExpanded(result.filePath)}
                    onmouseenter={() => selectedIndex = globalIndex}
                    style="height: {ITEM_HEIGHT}px;"
                  >
                    <span class="show-more-text">{result.hiddenCount} more matches...</span>
                  </li>
                {:else}
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
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <span
                          class="expand-chevron"
                          class:expanded={expandedFiles.has(result.filePath)}
                          onclick={(e: MouseEvent) => { e.stopPropagation(); toggleFileExpanded(result.filePath); }}
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                          </svg>
                        </span>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="file-icon">
                          <path d="M3 2C3 1.44772 3.44772 1 4 1H9L14 6V14C14 14.5523 13.5523 15 13 15H4C3.44772 15 3 14.5523 3 14V2Z" fill="var(--accent)" fill-opacity="0.15"/>
                          <path d="M3 2C3 1.44772 3.44772 1 4 1H9L14 6V14C14 14.5523 13.5523 15 13 15H4C3.44772 15 3 14.5523 3 14V2Z" stroke="var(--accent)" stroke-width="1"/>
                          <path d="M9 1V5C9 5.55228 9.44772 6 10 6H14" stroke="var(--accent)" stroke-width="1"/>
                        </svg>
                        <span class="file-name">{result.relativePath}</span>
                        <span class="match-count">{result.totalFileMatches}</span>
                      </div>
                    {/if}
                    <div class="match-row">
                      <span class="line-number">{result.match.lineNumber}</span>
                      <span class="line-content">{@html highlightMatch(result.match.lineContent, result.match.matchStart, result.match.matchEnd)}</span>
                    </div>
                  </li>
                {/if}
              {/each}
            </div>
          </ul>
        {:else if query && !loading && results.length === 0}
          <div class="no-results">No matches found</div>
        {:else if !query && !loading}
          <div class="no-results hint">Enter a search term and press Enter or click Search</div>
        {/if}
      </div>

      <div class="footer">
        <div class="stats">
          {#if results.length > 0}
            <span>{flattenedResults.length}{#if totalFlattenedCount > flattenedResults.length} of {totalFlattenedCount}{/if} matches in {results.length} files</span>
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
    padding: 0 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    box-sizing: border-box;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
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
    padding-top: 6px;
    padding-bottom: 4px;
  }

  .file-path {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    min-height: 20px;
  }

  .expand-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: transform 120ms ease;
    border-radius: 3px;
  }

  .expand-chevron:hover {
    color: var(--text-secondary);
    background: var(--subtle-fill-secondary);
  }

  .expand-chevron.expanded {
    transform: rotate(90deg);
  }

  .result-item.selected .expand-chevron {
    color: var(--text-on-accent);
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

  .match-count {
    font-size: 11px;
    color: var(--text-tertiary);
    background: var(--subtle-fill-secondary);
    padding: 0 6px;
    border-radius: 8px;
    flex-shrink: 0;
    line-height: 18px;
  }

  .result-item.selected .match-count {
    color: var(--text-on-accent);
    background: rgba(255, 255, 255, 0.2);
  }

  .result-item.selected .file-name {
    color: var(--text-on-accent);
  }

  .show-more-row {
    display: flex;
    align-items: center;
    padding-left: 48px;
  }

  .show-more-text {
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
    font-style: italic;
  }

  .show-more-row:hover .show-more-text,
  .show-more-row.selected .show-more-text {
    text-decoration: underline;
  }

  .result-item.selected .show-more-text {
    color: var(--text-on-accent);
  }

  .match-row {
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 20px;
    min-height: 20px;
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
