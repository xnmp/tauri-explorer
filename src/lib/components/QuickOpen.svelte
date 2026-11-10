<!--
  QuickOpen component - VSCode-style Ctrl+P file search
  Issue: tauri-explorer-w3t, tauri-explorer-btz, tauri-explorer-az6w

  Rendering, keyboard handling and store wiring only. The query, rows and
  recursive-search lifecycle live in state/quick-open-session; scoring and the
  bounded merge live in domain/quick-open-ranking (#1577).
-->
<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { startStreamingSearch, cancelSearch, fuzzySearch, type SearchResult, type SearchResultsEvent } from "$lib/api/search";
  import { openFile } from "$lib/api/open";
  import { refreshSharedHistory } from "$lib/state/shared-history";
  import { recentFilesStore } from "$lib/state/recent-files.svelte";
  import { homeDirectory } from "$lib/state/home.svelte";
  import { listen } from "@tauri-apps/api/event";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { parentDir, expandTilde as expandTildePath } from "$lib/domain/path";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { navigateFromQuickOpen } from "$lib/state/quick-open-navigation";
  import { clampedStep, pageKeyDelta } from "$lib/domain/palette-selection";
  import { usePointerIntent } from "$lib/composables/use-pointer-intent.svelte";
  import FileIcon from "./FileIcon.svelte";
  import Modal from "./Modal.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { createQuickOpenSession } from "$lib/state/quick-open-session.svelte";
  import {
    clampSelection,
    localQuickOpenMatches,
    quickOpenDisplayPath,
    quickOpenScoreBreakdown,
    rankBackendResults,
    recentQuickOpenResults,
  } from "$lib/domain/quick-open-ranking";

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

  let inputRef = $state<HTMLInputElement | null>(null);
  let resultsContainerRef = $state<HTMLElement | null>(null);
  const homeDir = $derived(homeDirectory.value);
  // Guard: hover may only change the selection after a DELIBERATE pointer move.
  // Rows react to mousemove (not mouseenter — that also fires when a row
  // re-renders or scrolls under a stationary cursor), and the move must clear a
  // small deadzone (ignore mouse drift), and every keyboard nav / results
  // update re-anchors so movement from before can't steal the selection.
  const pointer = usePointerIntent();

  // Get current working directory from active explorer
  function getCwdPath(): string {
    const explorer = windowTabsManager.getActiveExplorer();
    return explorer?.currentPath ?? "/";
  }

  const session = createQuickOpenSession({
    // Outside Tauri `listen` rejects and the session uses `fuzzySearch`.
    listen: (onEvent) => listen<SearchResultsEvent>("search-results", (event) => onEvent(event.payload)),
    startStream: startStreamingSearch,
    cancelStream: cancelSearch,
    fallbackSearch: fuzzySearch,
    localMatches: (term) => localQuickOpenMatches(term, {
      recents: recentFilesStore.list,
      frecencyPaths: frecencyStore.entries,
      scoreMap: frecencyStore.getScoreMap(),
      paneEntries: windowTabsManager.getActiveExplorer()?.ownDisplayEntries ?? [],
    }),
    rankBackend: (raw, term) => rankBackendResults(raw, term, frecencyStore.getScoreMap()),
    searchRoot: getCwdPath,
    onBackendResults: () => pointer.reset(),
  });
  onDestroy(() => session.close());

  // Show recent files when query is empty
  const recentResults = $derived<SearchResult[]>(
    recentQuickOpenResults(recentFilesStore.list, (path) => frecencyStore.getScore(path)),
  );

  // Active display list: search results when querying, recent files otherwise
  const displayResults = $derived(
    session.query.trim() ? session.results : recentResults.slice(0, 10)
  );

  function handleInput(value: string): void {
    pointer.reset();
    session.input(value);
  }

  // Escape is handled by Modal; everything else lands here.
  function handleKeydown(event: KeyboardEvent): void {
    // Alt+D toggles debug mode (shows score breakdown)
    if (event.key === "d" && event.altKey) {
      event.preventDefault();
      settingsStore.toggleQuickOpenDebug();
      return;
    }
    // Ctrl+Delete downvotes the highlighted result (Shift+Delete is reserved
    // for permanent file deletion elsewhere in the app, so we avoid it here).
    if (event.key === "Delete" && event.ctrlKey) {
      const highlighted = displayResults[session.selectedIndex];
      if (highlighted) {
        event.preventDefault();
        downvoteResult(highlighted);
      }
      return;
    }
    const selectedIndex = session.selectedIndex;
    const n = displayResults.length;
    const page = pageKeyDelta(event);
    const step =
      page !== null ? clampedStep(selectedIndex, page, n)
      : event.key === "ArrowDown" ? (selectedIndex + 1) % Math.max(n, 1)
      : event.key === "ArrowUp" ? (selectedIndex - 1 + n) % Math.max(n, 1)
      : null;
    if (step !== null) {
      event.preventDefault();
      if (n > 0) { session.selectedIndex = step; pointer.reset(); scrollToSelected(); }
      return;
    }
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        // If query looks like a path (starts with / or ~), navigate directly
        if (session.query.startsWith("/") || session.query.startsWith("~")) {
          void navigateFromQuickOpen(onClose, expandTildePath(session.query.trim(), homeDir));
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
    if (pointer.moved && session.selectedIndex !== index) {
      session.selectedIndex = index;
    }
  }

  function scrollToSelected(): void {
    tick().then(() => {
      const selected = resultsContainerRef?.querySelector(".result-item.selected");
      selected?.scrollIntoView({ block: "nearest" });
    });
  }

  async function selectResult(result: SearchResult): Promise<void> {
    if (result.kind === "directory") {
      // Jumping to a folder is navigation, not a file action — it no longer
      // feeds frecency (the Recent list ranks folders by file activity).
      await navigateFromQuickOpen(onClose, result.path);
      return;
    } else {
      const openResult = await openFile(result.path);
      if (openResult.ok) {
        recentFilesStore.add(result.path, result.name, "file");
        // Opening a file marks its folder as actively worked-in for Recent ranking.
        frecencyStore.recordFileAction(result.path);
      } else {
        await navigateFromQuickOpen(onClose, parentDir(result.path));
        return;
      }
    }

    onClose();
  }

  /** The frecency key a result's ranking is driven by. Directories are tracked
   *  under their own path; a file's frecency lives on its containing folder
   *  (that's what `recordFileAction` writes), so downvoting a file undoes the
   *  access it recorded — on its folder. */
  function frecencyKeyForResult(result: SearchResult): string {
    return result.kind === "directory" ? result.path : parentDir(result.path);
  }

  /** Downvote a result: soft-penalise its frecency (as if some accesses were
   *  forgotten) and drop it from the recents pin. Its ranking falls now but
   *  recovers if the item is opened again — not a permanent blacklist. */
  function downvoteResult(result: SearchResult, event?: Event): void {
    // Don't let a click on the row's downvote button open the result.
    event?.stopPropagation();
    frecencyStore.penalize(frecencyKeyForResult(result));
    recentFilesStore.remove(result.path);
    session.rerank();
    // Empty-query "Recent" view re-derives from recentFilesStore automatically;
    // just keep the selection in range.
    session.selectedIndex = clampSelection(session.selectedIndex, displayResults.length);
    // A click lands focus on the (removed) button, dropping it to <body> outside
    // the modal — which would break keyboard control (arrows / Enter / Ctrl+Del
    // all bubble from the input to the overlay). Pull focus back to the input so
    // the palette stays keyboard-driven after a downvote.
    inputRef?.focus();
  }

  // Reset the session, focus input and prune stale entries when dialog opens.
  // untrack keeps the session's and pruneNonExistent's internal $state reads
  // from becoming dependencies of this effect (tauri-explorer-m2x3).
  $effect(() => {
    if (open && inputRef) {
      untrack(() => session.open());
      pointer.arm();
      tick().then(() => inputRef?.focus());
      untrack(() => {
        void refreshSharedHistory().then(() => { recentFilesStore.pruneNonExistent(); frecencyStore.pruneNonExistent(); });
      });
    }
  });

  // Stop all search work on close.
  $effect(() => {
    if (!open) {
      untrack(() => session.close());
      pointer.disarm();
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
          bind:value={() => session.query, handleInput}
          bind:this={inputRef}
        />
        {#if session.loading}
          <div class="search-status">
            {#if session.totalScanned > 0}
              <span class="scanned-count">{session.totalScanned.toLocaleString()} scanned</span>
            {/if}
            <div class="spinner"></div>
          </div>
        {/if}
      </div>

      <div class="results-container" bind:this={resultsContainerRef}>
        {#if session.results.length > 0}
          <ul class="results-list" role="listbox">
            {#each session.results as result, index (result.path)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="result-item"
                class:selected={index === session.selectedIndex}
                class:is-directory={result.kind === "directory"}
                role="option"
                aria-selected={index === session.selectedIndex}
                onclick={() => selectResult(result)}
                onmousemove={(e) => handleRowMouseMove(e, index)}
              >
                <span class="result-icon" class:file-icon={result.kind !== "directory"}>
                  <FileIcon entry={toFileEntry(result)} size="small" />
                </span>
                <div class="result-content">
                  <span class="result-name">{result.name}</span>
                  <span class="result-path">{quickOpenDisplayPath(result.path, getCwdPath())}</span>
                </div>
                {#if settingsStore.quickOpenDebug}
                  {@const score = quickOpenScoreBreakdown(result, session.query, frecencyStore.getScoreMap())}
                  <span class="debug-breakdown" title={result.path}>
                    <span class="debug-row"><b>{score.effective}</b></span>
                    {#if score.base > 0}
                      <span class="debug-row">fuzzy:{score.base}</span>
                    {/if}
                    {#if score.name > 0}
                      <span class="debug-row">name:{score.name}</span>
                    {/if}
                    {#if score.frecency > 0}
                      <span class="debug-row">frec:{score.frecency}</span>
                    {/if}
                    {#if score.base === 0 && score.frecency === 0 && score.name === 0}
                      <span class="debug-row">recent</span>
                    {/if}
                    {#if score.directoryMultiplier !== 1}<span class="debug-row">dir:×{score.directoryMultiplier}</span>{/if}
                  </span>
                {:else if result.kind === "directory"}
                  <span class="result-kind">folder</span>
                {:else}
                  <span class="result-score">{Math.round(result.score)}%</span>
                {/if}
                <button
                  type="button"
                  class="downvote-btn"
                  tabindex="-1"
                  aria-label="Downvote this result"
                  title="Downvote — lowers this result's ranking. Not permanent: it recovers if you open it again. (Ctrl+Delete)"
                  onclick={(e) => downvoteResult(result, e)}
                  onmousemove={(e) => e.stopPropagation()}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M9.5 2H5.2C4.6 2 4.1 2.4 4 3l-1.3 5c-.1.6.4 1.2 1 1.2H6l-.5 2.4c-.1.6.2 1.2.8 1.3.3.1.6-.1.8-.4L9.8 9.2h2.5c.6 0 1-.5 1-1V3c0-.6-.4-1-1-1z" fill="currentColor"/>
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
        {:else if session.query && !session.loading}
          <div class="no-results">No matching files found</div>
        {:else if !session.query && recentResults.length > 0}
          <div class="section-label">Recent</div>
          <ul class="results-list" role="listbox">
            {#each recentResults.slice(0, 10) as result, index (result.path)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="result-item"
                class:selected={index === session.selectedIndex}
                class:is-directory={result.kind === "directory"}
                role="option"
                aria-selected={index === session.selectedIndex}
                onclick={() => selectResult(result)}
                onmousemove={(e) => handleRowMouseMove(e, index)}
              >
                <span class="result-icon" class:file-icon={result.kind !== "directory"}>
                  <FileIcon entry={toFileEntry(result)} size="small" />
                </span>
                <div class="result-content">
                  <span class="result-name">{result.name}</span>
                  <span class="result-path">{quickOpenDisplayPath(result.path, getCwdPath())}</span>
                </div>
                <span class="result-kind recent-badge">recent</span>
                <button
                  type="button"
                  class="downvote-btn"
                  tabindex="-1"
                  aria-label="Downvote this result"
                  title="Downvote — lowers this result's ranking. Not permanent: it recovers if you open it again. (Ctrl+Delete)"
                  onclick={(e) => downvoteResult(result, e)}
                  onmousemove={(e) => e.stopPropagation()}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M9.5 2H5.2C4.6 2 4.1 2.4 4 3l-1.3 5c-.1.6.4 1.2 1 1.2H6l-.5 2.4c-.1.6.2 1.2.8 1.3.3.1.6-.1.8-.4L9.8 9.2h2.5c.6 0 1-.5 1-1V3c0-.6-.4-1-1-1z" fill="currentColor"/>
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
        {:else if !session.query}
          <div class="no-results hint">Start typing to search files...</div>
        {/if}
      </div>

      <div class="footer">
        <span class="shortcut"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span class="shortcut"><kbd>Enter</kbd> Open</span>
        <span class="shortcut"><kbd>Ctrl+Del</kbd> Downvote</span>
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
    /* No entrance animation: palette-style surfaces must be legible the frame
       they open (VSCode behavior) — a fade/slide reads as input lag (#234). */
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

  .downvote-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    margin-left: -4px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    /* Hidden until the row is hovered or selected — an unobtrusive affordance. */
    opacity: 0;
    transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  }

  .result-item:hover .downvote-btn,
  .result-item.selected .downvote-btn {
    opacity: 0.7;
  }

  .downvote-btn:hover {
    opacity: 1;
    background: var(--subtle-fill-tertiary);
    color: var(--system-critical-text, var(--system-critical));
  }

  .result-item.selected .downvote-btn {
    color: var(--text-on-accent);
  }

  .result-item.selected .downvote-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    color: var(--text-on-accent);
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
