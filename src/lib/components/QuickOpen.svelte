<!--
  QuickOpen component - VSCode-style Ctrl+P file search
  Issue: tauri-explorer-w3t, tauri-explorer-btz, tauri-explorer-az6w
-->
<script lang="ts">
  import { tick, untrack } from "svelte";
  import { filenameMatchScore, fuzzyScorePath } from "$lib/domain/fuzzy-score";
  import {
    startStreamingSearch,
    cancelSearch,
    fuzzySearch,
    openFile,
    type SearchResult,
    type SearchResultsEvent,
  } from "$lib/api/files";
  import { recentFilesStore } from "$lib/state/recent-files.svelte";
  import { homeDirectory } from "$lib/state/home.svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { parentDir, basename, directoryKey, toForwardSlashes, expandTilde as expandTildePath } from "$lib/domain/path";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { usePointerIntent } from "$lib/composables/use-pointer-intent.svelte";
  import FileIcon from "./FileIcon.svelte";
  import Modal from "./Modal.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { frecencyStore } from "$lib/state/frecency.svelte";

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

  let query = $state("");
  let results = $state<SearchResult[]>([]);
  let selectedIndex = $state(0);
  let loading = $state(false);
  let inputRef = $state<HTMLInputElement | null>(null);
  let resultsContainerRef = $state<HTMLElement | null>(null);
  const homeDir = $derived(homeDirectory.value);
  // Guard: hover may only change the selection after a DELIBERATE pointer move.
  // Rows react to mousemove (not mouseenter — that also fires when a row
  // re-renders or scrolls under a stationary cursor), and the move must clear a
  // small deadzone (ignore mouse drift), and every keyboard nav / results
  // update re-anchors so movement from before can't steal the selection.
  const pointer = usePointerIntent();


  /** Expand leading ~ to home directory path */
  function expandTilde(path: string): string {
    return expandTildePath(path, homeDir);
  }

  // Debounce timer for search
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Streaming search state
  let activeSearchId: number | null = null;
  let unlisten: UnlistenFn | null = null;
  let totalScanned = $state(0);

  // Frecency weight relative to fuzzy score (how much frecency influences ranking)
  const FRECENCY_WEIGHT = 50;
  // Directories get a score boost since they're more commonly navigated to
  const DIRECTORY_BONUS = 1.25;

  /** Match recent files and frecency entries against a search term.
   *  These are always included in results (merged/deduplicated with backend results). */
  function matchFrecencyAndRecent(term: string): SearchResult[] {
    const lower = term.toLowerCase();
    const seen = new Set<string>();
    const matched: SearchResult[] = [];
    const scoreMap = frecencyStore.getScoreMap();

    // Recent files — scored with full fuzzy matching
    for (const entry of recentFilesStore.list) {
      const key = directoryKey(entry.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const fuzzy = fuzzyScorePath(lower, entry.path);
      if (fuzzy > 0) {
        const frecency = scoreMap.get(key) ?? 0;
        const nameBonus = filenameMatchScore(entry.name, lower);
        matched.push({
          name: entry.name,
          path: entry.path,
          relativePath: entry.path,
          score: Math.round(fuzzy * 5) + nameBonus + Math.round(frecency * FRECENCY_WEIGHT),
          kind: entry.kind,
        });
      }
    }

    // Frecency entries (mostly directories the user has navigated to)
    for (const entry of frecencyStore.entries) {
      const key = directoryKey(entry.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const name = basename(entry.path);
      const fuzzy = fuzzyScorePath(lower, entry.path);
      if (fuzzy > 0) {
        const frecency = scoreMap.get(key) ?? 0;
        const nameBonus = filenameMatchScore(name, lower);
        matched.push({
          name,
          path: entry.path,
          relativePath: entry.path,
          score: Math.round(fuzzy * 5) + nameBonus + Math.round(frecency * FRECENCY_WEIGHT),
          kind: "directory",
        });
      }
    }

    return matched;
  }

  /** Re-rank search results by combining fuzzy score with frecency and filename bonus. */
  function rankWithFrecency(searchResults: SearchResult[]): SearchResult[] {
    if (searchResults.length === 0) return searchResults;
    const scoreMap = frecencyStore.getScoreMap();
    const currentQuery = query.toLowerCase();
    const ranked = searchResults.map((r) => {
      const frecency = scoreMap.get(directoryKey(r.path)) ?? 0;
      const nameBonus = filenameMatchScore(r.name, currentQuery);
      return { ...r, score: r.score + Math.round(frecency * FRECENCY_WEIGHT) + nameBonus };
    });
    ranked.sort((a, b) => effectiveScore(b) - effectiveScore(a));
    return ranked;
  }

  /** Effective score with directory bonus applied. */
  function effectiveScore(r: SearchResult): number {
    return r.kind === "directory" ? r.score * DIRECTORY_BONUS : r.score;
  }

  /** Merge primary results with extras (deduplicated), sorted by score descending. */
  function mergeResultsByScore(primary: SearchResult[], extras: SearchResult[]): SearchResult[] {
    const seen = new Set(primary.map((r) => directoryKey(r.path)));
    const unique = extras.filter((r) => !seen.has(directoryKey(r.path)));
    const merged = [...primary, ...unique];
    merged.sort((a, b) => effectiveScore(b) - effectiveScore(a));
    return merged;
  }

  // Show recent files when query is empty
  const recentResults = $derived<SearchResult[]>(
    recentFilesStore.list.map((entry) => ({
      name: entry.name,
      path: entry.path,
      relativePath: entry.path,
      score: 0,
      kind: entry.kind,
    }))
  );

  // Get current working directory from active explorer
  function getCwdPath(): string {
    const explorer = windowTabsManager.getActiveExplorer();
    return explorer?.currentPath ?? "/";
  }

  /** Path shown in a result row: relative to the current folder when the file
   *  lives under it (just the filename for a direct child), otherwise the full
   *  path. Keeps cwd results compact instead of repeating the whole prefix. */
  function displayPath(fullPath: string): string {
    const cwdKey = directoryKey(getCwdPath());
    const fileKey = directoryKey(fullPath);
    if (cwdKey && cwdKey !== "/" && fileKey.startsWith(cwdKey + "/")) {
      // cwdKey only differs from the forward-slashed cwd by case folding, which
      // preserves length, so slicing the forward-slash form by its length
      // strips exactly the "cwd/" prefix while keeping the original casing.
      return toForwardSlashes(fullPath).slice(cwdKey.length + 1);
    }
    return fullPath;
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

  // Monotonically increasing search generation counter.
  // Used to discard stale results without needing to wait for searchId.
  let searchGeneration = 0;

  // Setup event listener for streaming search results.
  // Must be called BEFORE starting the search to avoid missing events
  // from fast-completing searches (e.g. small directories).
  async function setupSearchListener(generation: number): Promise<void> {
    // Clean up any existing listener
    if (unlisten) {
      unlisten();
    }

    unlisten = await listen<SearchResultsEvent>("search-results", (event) => {
      const payload = event.payload;

      // Discard events from stale searches (user typed again)
      if (generation !== searchGeneration) {
        return;
      }

      // Accept events that match our search ID, OR if we haven't received
      // the search ID yet (race: backend thread emits before invoke returns).
      // Once we learn the ID from the first event, lock to it.
      if (activeSearchId === null) {
        activeSearchId = payload.searchId;
      } else if (payload.searchId !== activeSearchId) {
        return;
      }

      // Rank backend results by frecency, then merge in recent/frecent matches
      const ranked = rankWithFrecency(payload.results);
      const frecencyMatches = matchFrecencyAndRecent(query);
      results = mergeResultsByScore(ranked, frecencyMatches);
      pointer.reset();
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
    pointer.reset();

    if (!query.trim()) {
      cancelActiveSearch();
      results = [];
      selectedIndex = 0;
      totalScanned = 0;
      loading = false;
      return;
    }

    loading = true;
    // New query → selection pins back to the top result (VSCode behavior),
    // even if hover or arrows had moved it in the previous result set.
    selectedIndex = 0;
    searchTimer = setTimeout(async () => {
      // Claim a generation synchronously so debounce callbacks that
      // interleave across the awaits below can detect they're stale.
      const generation = ++searchGeneration;

      // Cancel any previous search
      await cancelActiveSearch();
      if (generation !== searchGeneration) return;

      // Show frecency/recent matches immediately (before backend responds)
      const frecencyMatches = matchFrecencyAndRecent(query);
      results = frecencyMatches;

      // Search from CWD so immediate directory contents are always found
      const cwd = getCwdPath();

      // Try streaming search (requires Tauri event system).
      // Falls back to non-streaming fuzzySearch when events aren't available
      // (e.g. browser/mock mode).
      let streamingAvailable = true;
      try {
        await setupSearchListener(generation);
      } catch {
        streamingAvailable = false;
      }
      if (generation !== searchGeneration) return;

      if (streamingAvailable) {
        const result = await startStreamingSearch(query, cwd, 20);
        if (generation !== searchGeneration) {
          // Superseded while awaiting: cancel the now-orphaned backend search
          if (result.ok) cancelSearch(result.data);
          return;
        }
        if (result.ok) {
          activeSearchId = result.data;
        } else {
          loading = false;
        }
      } else {
        // Fallback: non-streaming search
        const result = await fuzzySearch(query, cwd, 20);
        if (generation !== searchGeneration) return;
        if (result.ok) {
          const ranked = rankWithFrecency(result.data);
          results = mergeResultsByScore(ranked, frecencyMatches);
          pointer.reset();
        }
        loading = false;
      }
    }, 50); // Shorter debounce for streaming - results come in progressively
  }

  // Active display list: search results when querying, recent files otherwise
  const displayResults = $derived(
    query.trim() ? results : recentResults.slice(0, 10)
  );

  // Escape is handled by Modal; everything else lands here.
  function handleKeydown(event: KeyboardEvent): void {
    // Alt+D toggles debug mode (shows score breakdown)
    if (event.key === "d" && event.altKey) {
      event.preventDefault();
      settingsStore.toggleQuickOpenDebug();
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (displayResults.length > 0) {
          selectedIndex = (selectedIndex + 1) % displayResults.length;
          pointer.reset();
          scrollToSelected();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (displayResults.length > 0) {
          selectedIndex = (selectedIndex - 1 + displayResults.length) % displayResults.length;
          pointer.reset();
          scrollToSelected();
        }
        break;
      case "Enter":
        event.preventDefault();
        // If query looks like a path (starts with / or ~), navigate directly
        if (query.startsWith("/") || query.startsWith("~")) {
          const explorer = windowTabsManager.getActiveExplorer();
          explorer?.navigateTo(expandTilde(query.trim()));
          onClose();
        } else if (displayResults[selectedIndex]) {
          selectResult(displayResults[selectedIndex]);
        }
        break;
    }
  }

  /** Hover-selection via deliberate pointer movement only. Runs before the
   *  dialog-level tracker (mousemove bubbles), so it feeds the tracker itself. */
  function handleRowMouseMove(event: MouseEvent, index: number): void {
    pointer.track(event.clientX, event.clientY);
    if (pointer.moved && selectedIndex !== index) {
      selectedIndex = index;
    }
  }

  function scrollToSelected(): void {
    tick().then(() => {
      const selected = resultsContainerRef?.querySelector(".result-item.selected");
      selected?.scrollIntoView({ block: "nearest" });
    });
  }

  async function selectResult(result: SearchResult): Promise<void> {
    const explorer = windowTabsManager.getActiveExplorer();

    if (result.kind === "directory") {
      // Jumping to a folder is navigation, not a file action — it no longer
      // feeds frecency (the Recent list ranks folders by file activity).
      explorer?.navigateTo(result.path);
    } else {
      const openResult = await openFile(result.path);
      if (openResult.ok) {
        recentFilesStore.add(result.path, result.name, "file");
        // Opening a file marks its folder as actively worked-in for Recent ranking.
        frecencyStore.recordFileAction(result.path);
      } else {
        const resultDir = parentDir(result.path);
        explorer?.navigateTo(resultDir);
      }
    }

    onClose();
  }

  // Focus input and prune stale entries when dialog opens.
  // untrack prevents pruneNonExistent's internal $state reads from
  // becoming dependencies of this effect (tauri-explorer-m2x3).
  $effect(() => {
    if (open && inputRef) {
      query = "";
      results = [];
      selectedIndex = 0;
      pointer.arm();
      tick().then(() => inputRef?.focus());
      untrack(() => {
        recentFilesStore.pruneNonExistent();
        frecencyStore.pruneNonExistent();
      });
    }
  });

  // Cleanup on close
  $effect(() => {
    if (!open) {
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      pointer.disarm();
      // Cancel any active streaming search
      cancelActiveSearch();
      totalScanned = 0;
    }
  });
</script>

<Modal
  {open}
  {onClose}
  overlayClass="quick-open-overlay"
  align="top"
  topOffset="15vh"
  label="Quick open"
  onkeydown={handleKeydown}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="quick-open-dialog"
    onmousemove={(e) => pointer.track(e.clientX, e.clientY)}>
      <div class="search-container">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="search-icon">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <input
          type="text"
          class="search-input"
          placeholder="Search files..."
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
          name="quickopen-nofill"
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

      <div class="results-container" bind:this={resultsContainerRef}>
        {#if results.length > 0}
          <ul class="results-list" role="listbox">
            {#each results as result, index (result.path)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="result-item"
                class:selected={index === selectedIndex}
                class:is-directory={result.kind === "directory"}
                role="option"
                aria-selected={index === selectedIndex}
                onclick={() => selectResult(result)}
                onmousemove={(e) => handleRowMouseMove(e, index)}
              >
                <span class="result-icon" class:file-icon={result.kind !== "directory"}>
                  <FileIcon entry={toFileEntry(result)} size="small" />
                </span>
                <div class="result-content">
                  <span class="result-name">{result.name}</span>
                  <span class="result-path">{displayPath(result.path)}</span>
                </div>
                {#if settingsStore.quickOpenDebug}
                  {@const qLower = query.toLowerCase()}
                  {@const nameScore = filenameMatchScore(result.name, qLower)}
                  {@const frecency = frecencyStore.getScoreMap().get(directoryKey(result.path)) ?? 0}
                  {@const frecencyPts = Math.round(frecency * FRECENCY_WEIGHT)}
                  {@const baseScore = Math.round(result.score - frecencyPts - nameScore)}
                  {@const dirMult = result.kind === "directory" ? 1.25 : 1}
                  {@const effective = Math.round(effectiveScore(result))}
                  <span class="debug-breakdown" title={result.path}>
                    <span class="debug-row"><b>{effective}</b></span>
                    {#if baseScore > 0}
                      <span class="debug-row">fuzzy:{baseScore}</span>
                    {/if}
                    {#if nameScore > 0}
                      <span class="debug-row">name:{nameScore}</span>
                    {/if}
                    {#if frecencyPts > 0}
                      <span class="debug-row">frec:{frecencyPts}</span>
                    {/if}
                    {#if baseScore === 0 && frecencyPts === 0 && nameScore === 0}
                      <span class="debug-row">recent</span>
                    {/if}
                    {#if dirMult !== 1}<span class="debug-row">dir:×{dirMult}</span>{/if}
                  </span>
                {:else if result.kind === "directory"}
                  <span class="result-kind">folder</span>
                {:else}
                  <span class="result-score">{Math.round(result.score)}%</span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else if query && !loading}
          <div class="no-results">No matching files found</div>
        {:else if !query && recentResults.length > 0}
          <div class="section-label">Recent</div>
          <ul class="results-list" role="listbox">
            {#each recentResults.slice(0, 10) as result, index (result.path)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="result-item"
                class:selected={index === selectedIndex}
                class:is-directory={result.kind === "directory"}
                role="option"
                aria-selected={index === selectedIndex}
                onclick={() => selectResult(result)}
                onmousemove={(e) => handleRowMouseMove(e, index)}
              >
                <span class="result-icon" class:file-icon={result.kind !== "directory"}>
                  <FileIcon entry={toFileEntry(result)} size="small" />
                </span>
                <div class="result-content">
                  <span class="result-name">{result.name}</span>
                  <span class="result-path">{displayPath(result.path)}</span>
                </div>
                <span class="result-kind recent-badge">recent</span>
              </li>
            {/each}
          </ul>
        {:else if !query}
          <div class="no-results hint">Start typing to search files...</div>
        {/if}
      </div>

      <div class="footer">
        <span class="shortcut"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span class="shortcut"><kbd>Enter</kbd> Open</span>
        <span class="shortcut"><kbd>Esc</kbd> Close</span>
        <span class="shortcut"><kbd>Alt+D</kbd> {settingsStore.quickOpenDebug ? "Debug ON" : "Debug"}</span>
      </div>
  </div>
</Modal>

<style>
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

  .result-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
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
    color: var(--icon-folder, #B38F00);
    background: color-mix(in srgb, var(--icon-folder, #FFB900) 15%, transparent);
  }

  .result-item.selected .result-score,
  .result-item.selected .result-kind {
    background: rgba(255, 255, 255, 0.2);
  }

  .result-item.is-directory {
    border-left: 2px solid var(--icon-folder, #FFB900);
    padding-left: 10px;
  }

  .result-item.selected.is-directory {
    border-left-color: rgba(255, 255, 255, 0.5);
  }

  .section-label {
    padding: 8px 16px 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
  }

  .recent-badge {
    color: var(--text-tertiary);
    background: var(--subtle-fill-secondary);
    font-size: 10px;
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

  .debug-breakdown {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    font-family: monospace;
    font-size: 9px;
    color: var(--text-tertiary);
    flex-shrink: 0;
    line-height: 1.2;
  }

  .debug-breakdown b {
    color: var(--text-primary);
    font-size: 11px;
  }

  .debug-row {
    white-space: nowrap;
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
