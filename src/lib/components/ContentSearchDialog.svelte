<!--
  ContentSearchDialog - Ctrl+Shift+F content search using ripgrep
  Issue: tauri-explorer-evim, tauri-explorer-3a1q, tauri-explorer-en98, tauri-nczo

  Stream lifecycle (search id, event listener, generation counter, dedup)
  lives in composables/use-content-search.svelte.ts; pure flattening in
  domain/content-search-flatten.ts. This component owns input/selection UI.
-->
<script lang="ts">
  import { tick } from "svelte";
  import { openFile, openFileAtLine } from "$lib/api/files";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { parentDir } from "$lib/domain/path";
  import { highlightMatch, type FlattenedResult } from "$lib/domain/content-search-flatten";
  import { useContentSearch } from "$lib/composables/use-content-search.svelte";
  import VirtualList from "./VirtualList.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  const search = useContentSearch();

  let query = $state("");
  let filterQuery = $state("");
  let caseSensitive = $state(false);
  let regexMode = $state(false);
  let selectedIndex = $state(0);
  let inputRef = $state<HTMLInputElement | null>(null);
  let scrollToIndex = $state<((index: number) => void) | undefined>();

  // Guard: suppress mouseenter on results until the user actually moves the mouse.
  // Prevents selection from jumping as streamed rows shift under a stationary cursor.
  // Track coordinates because macOS WebKit fires a synthetic mousemove (zero delta)
  // when an element renders under a stationary cursor.
  let mouseMoved = $state(false);
  let lastMousePos = $state<{ x: number; y: number } | null>(null);
  let mouseTrackingReady = $state(false);
  let mouseTrackingTimer: ReturnType<typeof setTimeout> | null = null;

  const ITEM_HEIGHT = 30;
  const FILE_HEADER_HEIGHT = 54;

  // Selection clamped to the live list — streamed batches and filter changes
  // shrink/grow the list without needing imperative re-clamping.
  const sel = $derived(
    Math.max(0, Math.min(selectedIndex, search.flattened.length - 1))
  );

  // Get root directory from active explorer
  function getRootPath(): string {
    const explorer = windowTabsManager.getActiveExplorer();
    return explorer?.currentPath ?? "/";
  }

  // Debounced auto-search: triggers search as user types
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 200;

  // True when the query changed since the last search was started, so Enter
  // re-runs the search instead of opening a stale selected result.
  let queryDirty = false;

  function handleInput(): void {
    queryDirty = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!query.trim()) return;
    debounceTimer = setTimeout(() => {
      startSearch();
    }, DEBOUNCE_MS);
  }

  function startSearch(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (!query.trim()) {
      return;
    }
    queryDirty = false;
    selectedIndex = 0;
    void search.start(query, getRootPath(), { caseSensitive, regexMode });
  }

  // Escape is handled by Modal; everything else lands here.
  function handleKeydown(event: KeyboardEvent): void {
    // Alt+C toggles match case, Alt+R toggles regex (advertised in tooltips).
    // event.code is used because macOS Option+key produces special characters.
    if (event.altKey && event.code === "KeyC") {
      event.preventDefault();
      caseSensitive = !caseSensitive;
      if (query.trim()) startSearch();
      return;
    }
    if (event.altKey && event.code === "KeyR") {
      event.preventDefault();
      regexMode = !regexMode;
      if (query.trim()) startSearch();
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (search.flattened.length > 0) {
          selectedIndex = (sel + 1) % search.flattened.length;
          mouseMoved = false;
          scrollToIndex?.(selectedIndex);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (search.flattened.length > 0) {
          selectedIndex = (sel - 1 + search.flattened.length) % search.flattened.length;
          mouseMoved = false;
          scrollToIndex?.(selectedIndex);
        }
        break;
      case "Enter":
        event.preventDefault();
        if (event.target === inputRef && (queryDirty || search.flattened.length === 0)) {
          startSearch();
        } else if (search.flattened[sel]) {
          const selected = search.flattened[sel];
          if (selected.isShowMore) {
            search.toggleExpanded(selected.filePath);
          } else {
            selectResult(selected);
          }
        }
        break;
    }
  }

  async function selectResult(result: FlattenedResult): Promise<void> {
    const line = result.match?.lineNumber ?? 0;
    const openResult = line > 0
      ? await openFileAtLine(result.filePath, line)
      : await openFile(result.filePath);
    if (!openResult.ok) {
      const explorer = windowTabsManager.getActiveExplorer();
      const resultDir = parentDir(result.filePath);
      explorer?.navigateTo(resultDir);
    }
    onClose();
  }

  // Focus input when dialog opens
  $effect(() => {
    if (open && inputRef) {
      query = "";
      filterQuery = "";
      queryDirty = false;
      selectedIndex = 0;
      search.reset();
      mouseMoved = false;
      lastMousePos = null;
      mouseTrackingReady = false;
      if (mouseTrackingTimer) clearTimeout(mouseTrackingTimer);
      mouseTrackingTimer = setTimeout(() => { mouseTrackingReady = true; }, 150);
      tick().then(() => inputRef?.focus());
    }
  });

  // Cleanup on close
  $effect(() => {
    if (!open) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (mouseTrackingTimer) {
        clearTimeout(mouseTrackingTimer);
        mouseTrackingTimer = null;
      }
      search.reset();
    }
  });
</script>

<Modal
  {open}
  {onClose}
  overlayClass="content-search-overlay"
  align="top"
  topOffset="10vh"
  label="Search in files"
  onkeydown={handleKeydown}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="content-search-dialog"
    onmousemove={(e) => {
      if (!mouseTrackingReady) return;
      if (lastMousePos && (e.clientX !== lastMousePos.x || e.clientY !== lastMousePos.y)) {
        mouseMoved = true;
      }
      lastMousePos = { x: e.clientX, y: e.clientY };
    }}>
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
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            bind:value={query}
            bind:this={inputRef}
            oninput={handleInput}
          />
          <div class="search-options">
            <button
              class="option-btn"
              class:active={caseSensitive}
              onclick={() => { caseSensitive = !caseSensitive; if (query.trim()) startSearch(); }}
              title="Match Case (Alt+C)"
            >
              Aa
            </button>
            <button
              class="option-btn"
              class:active={regexMode}
              onclick={() => { regexMode = !regexMode; if (query.trim()) startSearch(); }}
              title="Use Regex (Alt+R)"
            >
              .*
            </button>
            <button
              class="search-btn"
              onclick={startSearch}
              disabled={!query.trim() || search.loading}
            >
              Search
            </button>
          </div>
        </div>

        {#if search.fileCount > 0}
          <div class="filter-container">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="filter-icon">
              <path d="M2 4H14M4 8H12M6 12H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <input
              type="text"
              class="filter-input"
              placeholder="Filter results..."
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
              bind:value={filterQuery}
              oninput={() => search.setFilter(filterQuery)}
            />
          </div>
        {/if}
      </div>

      <div class="results-container">
        {#if search.loading}
          <div class="search-status">
            <div class="spinner"></div>
            <span>Searching... {search.filesSearched.toLocaleString()} files scanned, {search.totalMatches.toLocaleString()} matches</span>
          </div>
        {/if}

        {#if search.flattened.length > 0}
          <VirtualList
            items={search.flattened}
            itemHeight={ITEM_HEIGHT}
            getItemHeight={(r) => (r.isFirstInFile ? FILE_HEADER_HEIGHT : ITEM_HEIGHT)}
            getKey={(r) => r.filePath + ":" + (r.isShowMore ? "more" : r.match.lineNumber + ":" + r.match.column)}
            role="listbox"
            bind:scrollToIndex
          >
            {#snippet children(result, index)}
              {#if result.isShowMore}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="result-item show-more-row"
                  class:selected={index === sel}
                  role="option"
                  aria-selected={index === sel}
                  tabindex="-1"
                  onclick={() => search.toggleExpanded(result.filePath)}
                  onmouseenter={() => { if (mouseMoved) selectedIndex = index; }}
                >
                  <span class="show-more-text">{result.hiddenCount} more matches...</span>
                </div>
              {:else}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="result-item"
                  class:selected={index === sel}
                  class:file-header={result.isFirstInFile}
                  role="option"
                  aria-selected={index === sel}
                  tabindex="-1"
                  onclick={() => selectResult(result)}
                  onmouseenter={() => { if (mouseMoved) selectedIndex = index; }}
                >
                  {#if result.isFirstInFile}
                    <div class="file-path">
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <span
                        class="expand-chevron"
                        class:expanded={search.expandedFiles.has(result.filePath)}
                        onclick={(e: MouseEvent) => { e.stopPropagation(); search.toggleExpanded(result.filePath); }}
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
                </div>
              {/if}
            {/snippet}
          </VirtualList>
        {:else if query && !search.loading && search.fileCount === 0}
          <div class="no-results">No matches found</div>
        {:else if !query && !search.loading}
          <div class="no-results hint">Start typing to search in files</div>
        {/if}
      </div>

      <div class="footer">
        <div class="stats">
          {#if search.fileCount > 0}
            <span>{search.totalMatches.toLocaleString()} matches in {search.fileCount} files</span>
          {/if}
        </div>
        <div class="shortcuts">
          <span class="shortcut"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span class="shortcut"><kbd>Enter</kbd> Open</span>
          <span class="shortcut"><kbd>Esc</kbd> Close</span>
        </div>
      </div>
  </div>
</Modal>

<style>
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
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
    flex-shrink: 0;
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

  .result-item {
    height: 100%;
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
    flex-direction: row;
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
