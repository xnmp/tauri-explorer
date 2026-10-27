<!--
  ScmSidebarView - Source Control panel (#54).

  Sections: Merge / Staged / Changes / Untracked — each collapsible with a
  count badge. Each row carries hover actions (stage, unstage, discard).
  Commit input at the top with amend toggle and inline validation. Empty
  state when the active pane is not inside a git repo. Auto-refreshes on
  the `git-status-changed` watcher event.
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getScmStore } from "$lib/state/scm.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { showFileHistoryInPane } from "$lib/state/git-graph-file-history";
  import { createScmSidebarActions, type DiscardTarget } from "$lib/state/scm-sidebar-actions";
  import type { GitFileEntry } from "$lib/api/git";
  import { gitOpStateLabel } from "$lib/domain/git";
  import {
    canCommitScm,
    nextScmSelection,
    visibleScmRowPaths,
    type ScmSectionKind,
  } from "$lib/domain/scm-sidebar";
  import {
    filterScmSummary,
    isScmFilterActive,
    scmEmptyState,
    showScmFilterInput,
  } from "$lib/domain/scm-filter";
  import ScmCommitPanel from "./scm/ScmCommitPanel.svelte";
  import ScmSection from "./scm/ScmSection.svelte";
  import Modal from "./Modal.svelte";

  // Per-pane store (#334): this view tracks the pane it is mounted in, so a
  // second pane on another repo gets its own independent SCM panel. Falls
  // back to a shared "default" store when mounted outside a pane.
  const paneId = getPaneIdContext() ?? "default";
  const scmStore = getScmStore(paneId);
  const actions = createScmSidebarActions(() => scmStore);

  // Fuzzy filter over the pending files (#517). Only the query text lives
  // here; the narrowing rules are pure in $lib/domain/scm-filter.
  let filterQuery = $state("");
  const filterActive = $derived(isScmFilterActive(filterQuery));
  let filterInputEl: HTMLInputElement | undefined = $state();

  // Collapsed folder sets, keyed per repo root so toggling between repos
  // doesn't mix collapse state. While a filter is active every folder is
  // treated as expanded — a match hidden inside a collapsed folder would
  // look like the filter had dropped it.
  let collapsedByRepo = $state(new Map<string, Set<string>>());
  const collapsedFolders = $derived(
    filterActive
      ? new Set<string>()
      : collapsedByRepo.get(scmStore.repoRoot ?? "") ?? new Set<string>()
  );
  function toggleFolder(dir: string): void {
    // While filtering, every folder renders expanded — accepting a toggle
    // here would rewrite the collapse state the user set beforehand, with no
    // visible effect until they clear the query.
    if (filterActive) return;
    const repo = scmStore.repoRoot ?? "";
    const next = new Set(collapsedByRepo.get(repo) ?? []);
    if (next.has(dir)) next.delete(dir); else next.add(dir);
    const map = new Map(collapsedByRepo);
    map.set(repo, next);
    collapsedByRepo = map;
  }

  let rootEl: HTMLDivElement | undefined;

  let stagedExpanded = $state(true);
  let changesExpanded = $state(true);
  let untrackedExpanded = $state(true);
  let mergeExpanded = $state(true);

  // Pending confirmation for destructive Discard/Remove actions. Shown as
  // an inline overlay; Esc cancels, Cancel is the default-focused button.
  let pendingDiscard = $state<DiscardTarget | null>(null);
  let cancelButtonEl: HTMLButtonElement | undefined = $state();

  function requestDiscard(paths: string[], isUntracked: boolean): void {
    pendingDiscard = { paths, isUntracked };
    queueMicrotask(() => cancelButtonEl?.focus());
  }

  async function confirmDiscard(): Promise<void> {
    const target = pendingDiscard;
    pendingDiscard = null;
    if (!target) return;
    await actions.discard(target);
  }

  function cancelDiscard(): void {
    pendingDiscard = null;
  }

  onMount(() => {
    scmStore.initWatcherListener();
    const explorer = windowTabsManager.getExplorer(paneId) ?? windowTabsManager.getActiveExplorer();
    if (explorer?.currentPath) scmStore.setActivePath(explorer.currentPath);
  });

  // Panel unmount (pane closed, panel toggled off, tab switched away):
  // detach the store so its watcher is released; the shared summary cache
  // keeps the repaint instant on remount (#334).
  onDestroy(() => {
    void scmStore.release();
  });

  // Track THIS pane's explorer path → repo root resolution (#334); panels in
  // other panes follow their own explorers. Genuine side effect (async IPC +
  // watcher registration), so $effect is appropriate here.
  $effect(() => {
    const explorer = windowTabsManager.getExplorer(paneId) ?? windowTabsManager.getActiveExplorer();
    const path = explorer?.currentPath;
    if (path) scmStore.setActivePath(path);
  });

  function onInitRepo(): Promise<void> {
    const explorer = windowTabsManager.getExplorer(paneId) ?? windowTabsManager.getActiveExplorer();
    return actions.initRepo(explorer?.currentPath);
  }

  const doCommit = (opts?: { forceAmend?: boolean }): Promise<void> =>
    actions.commit(opts, scmStore.amend);

  /** Open this pane's graph and hand its repository-relative SCM path to the
   *  graph filter. The handoff is buffered until the view mounts (#518). */
  function onShowFileHistory(path: string): void {
    const repoRoot = scmStore.repoRoot;
    if (!repoRoot || !path.trim()) return;
    showFileHistoryInPane(paneId, repoRoot, path, {
      currentRepoPath: windowTabsManager.getPaneGitGraph(paneId),
      showGraph: (root) => windowTabsManager.showGitGraphInPane(paneId, root),
    });
  }

  const onIgnore = (path: string) => actions.ignore(path);
  const onArchive = (paths: string[]) => actions.archive(paths);
  const onTrash = (paths: string[]) => actions.trash(paths);

  /** Move selection over the visible rows and move DOM focus with it so a
   *  subsequent Enter acts on the newly selected row. */
  function moveSelection(delta: 1 | -1): void {
    const path = nextScmSelection(visibleRowPaths, scmStore.selectedPath, delta);
    if (path === undefined) return;
    scmStore.setSelected(path);
    rootEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  }

  function onRowKeydown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    }
  }

  /** Rows the user sees: dir-scoped by the store (#380), then narrowed by the
   *  sidebar's own fuzzy query (#517). Counts and keyboard navigation follow
   *  it; commit actions deliberately do not (they use `fullSummary`). */
  /** Dir-scoped rows, read once: `filteredSummary` is a plain getter that
   *  re-filters on every access, and both derivations below need it. */
  const dirScoped = $derived(scmStore.filteredSummary);
  const summary = $derived(filterScmSummary(dirScoped, filterQuery));
  const fullSummary = $derived(scmStore.summary);

  /** Row paths in the order the user actually sees them: filtered summary,
   *  collapsed sections and collapsed tree folders excluded. */
  const visibleRowPaths = $derived(visibleScmRowPaths([
    { rows: summary.merge, expanded: mergeExpanded },
    { rows: summary.staged, expanded: stagedExpanded },
    { rows: summary.changes, expanded: changesExpanded },
    { rows: summary.untracked, expanded: untrackedExpanded },
  ], settingsStore.scmTreeView, collapsedFolders));

  /** Pending rows before the text filter — decides whether there is anything
   *  to filter at all (no input on a clean tree). */
  const dirPendingCount = $derived(
    dirScoped.staged.length +
      dirScoped.changes.length +
      dirScoped.untracked.length +
      dirScoped.merge.length
  );

  function clearFilter(): void {
    filterQuery = "";
    filterInputEl?.focus();
  }

  function onFilterKeydown(e: KeyboardEvent): void {
    // Esc clears the query first; an already-empty filter lets the key bubble
    // so the surrounding UI keeps its own Esc behaviour.
    if (e.key === "Escape" && filterActive) {
      e.preventDefault();
      e.stopPropagation();
      clearFilter();
    }
  }
  const isRepo = $derived(fullSummary.is_repo);

  const stagedCount = $derived(summary.staged.length);
  const changesCount = $derived(summary.changes.length);
  const untrackedCount = $derived(summary.untracked.length);
  const mergeCount = $derived(summary.merge.length);

  /** Empty-list message: none / clean tree / filtered away (#517). */
  const emptyState = $derived(
    scmEmptyState(
      dirPendingCount,
      stagedCount + changesCount + untrackedCount + mergeCount,
      filterQuery
    )
  );

  const fullStagedCount = $derived(fullSummary.staged.length);
  const fullMergeCount = $derived(fullSummary.merge.length);

  // In-progress operation (repo-wide): drives the banner and blocks commits.
  const opState = $derived(fullSummary.op_state);
  const opInProgress = $derived(opState !== "clean");
  const opLabel = $derived(gitOpStateLabel(opState));

  const onAbortOperation = (): Promise<void> => actions.abortOperation(opLabel);
  const onContinueRebase = (): Promise<void> => actions.continueRebase();

  /** Whether the commit button should be active. Uses full (unfiltered) counts
   *  since commits operate repo-wide. */
  const canCommit = $derived(canCommitScm({
    isRepo,
    conflicted: fullMergeCount,
    staged: fullStagedCount,
    message: scmStore.commitMessage,
    amend: scmStore.amend,
  }));
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="sidebar-view scm-view" bind:this={rootEl} onkeydown={onRowKeydown} role="presentation">
  {#if scmStore.pending}
    <!-- Repo detection / first summary fetch in flight (#271): shimmer rows
         instead of prematurely claiming "not a git repository". -->
    <div class="loading-state" role="status" aria-label="Loading git status">
      {#each { length: 4 } as _, i}
        <div class="skeleton-row" style="--delay: {i * 120}ms">
          <span class="skeleton-block" style="width: {[62, 44, 71, 53][i]}%"></span>
          <span class="skeleton-block skeleton-letter"></span>
        </div>
      {/each}
    </div>
  {:else if !isRepo}
    <div class="empty-state">
      <div class="empty-title">Not a git repository</div>
      <div class="empty-hint">
        The current folder isn't tracked by git. Initialize a new repository to
        start tracking changes.
      </div>
      <button type="button" class="init-button" onclick={onInitRepo}>
        Initialize Repository
      </button>
    </div>
  {:else}
    {#if opInProgress}
      <div class="op-banner" role="status" data-op={opState}>
        <div class="op-banner-text">
          <span class="op-banner-title">{opLabel} in progress</span>
          <span class="op-banner-detail">
            {#if fullMergeCount > 0}
              {fullMergeCount} conflicted file{fullMergeCount === 1 ? "" : "s"} — resolve, then {opState === "rebase" ? "continue" : "commit"}
            {:else}
              conflicts resolved — {opState === "rebase" ? "continue the rebase" : "commit to finish"}
            {/if}
          </span>
        </div>
        <div class="op-banner-actions">
          {#if opState === "rebase"}
            <button
              type="button"
              class="op-banner-btn continue"
              disabled={fullMergeCount > 0}
              title={fullMergeCount > 0 ? "Resolve all conflicts first" : "git rebase --continue"}
              onclick={onContinueRebase}
            >Continue</button>
          {/if}
          <button
            type="button"
            class="op-banner-btn abort"
            title="Abort the {opLabel.toLowerCase()} and restore the previous state"
            onclick={onAbortOperation}
          >Abort</button>
        </div>
      </div>
    {/if}
    <ScmCommitPanel {scmStore} {summary} {canCommit} onCommit={doCommit} />

    {#if showScmFilterInput(dirPendingCount, filterQuery)}
      <div class="scm-filter">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="scm-filter-icon" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <input
          type="text"
          class="scm-filter-input"
          placeholder="Filter files"
          aria-label="Filter files"
          bind:this={filterInputEl}
          value={filterQuery}
          oninput={(e) => (filterQuery = (e.target as HTMLInputElement).value)}
          onkeydown={onFilterKeydown}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
          name="scm-filter-nofill"
        />
        {#if filterActive}
          <button
            type="button"
            class="scm-filter-clear"
            title="Clear filter (Esc)"
            aria-label="Clear filter"
            onclick={clearFilter}
          >×</button>
        {/if}
      </div>
    {/if}

    {#if mergeCount > 0}
      {@render section("merge", "Merge Changes", mergeCount, mergeExpanded, () => (mergeExpanded = !mergeExpanded), summary.merge)}
    {/if}

    {@render section("staged", "Staged Changes", stagedCount, stagedExpanded, () => (stagedExpanded = !stagedExpanded), summary.staged)}

    {@render section("changes", "Changes", changesCount, changesExpanded, () => (changesExpanded = !changesExpanded), summary.changes)}

    {@render section("untracked", "Untracked", untrackedCount, untrackedExpanded, () => (untrackedExpanded = !untrackedExpanded), summary.untracked)}

    <!-- A filtered-to-nothing list is not a clean tree, and a clean tree under
         a stale query is not a filter miss — scmEmptyState tells them apart. -->
    {#if emptyState === "no-match"}
      <div class="scm-no-match" role="status">No files match “{filterQuery.trim()}”</div>
    {:else if emptyState === "clean"}
      <div class="clean-state">Working tree clean</div>
    {/if}
  {/if}

  <Modal
    open={!!pendingDiscard}
    onClose={cancelDiscard}
    overlayClass="scm-confirm-overlay"
    role="alertdialog"
    labelledby="scm-confirm-title"
  >
    {#if pendingDiscard}
      {@const isUntracked = pendingDiscard.isUntracked}
      {@const count = pendingDiscard.paths.length}
      <div class="scm-confirm-dialog">
        <h2 id="scm-confirm-title" class="scm-confirm-title">
          {#if isUntracked}
            Remove {count === 1 ? "untracked file" : `${count} untracked files`}?
          {:else}
            Discard {count === 1 ? "change" : `${count} changes`}?
          {/if}
        </h2>
        <p class="scm-confirm-body">
          {#if isUntracked}
            <strong>{count === 1 ? pendingDiscard.paths[0] : `${count} files`}</strong>
            will be <strong>permanently deleted from disk</strong> — this is not just an unstage and cannot be undone.
          {:else}
            Working-tree changes to <strong>{count === 1 ? pendingDiscard.paths[0] : `${count} files`}</strong>
            will be reverted. This cannot be undone.
          {/if}
        </p>
        <div class="scm-confirm-actions">
          <button type="button" class="scm-confirm-btn secondary" bind:this={cancelButtonEl} onclick={cancelDiscard}>Cancel</button>
          <button type="button" class="scm-confirm-btn danger" onclick={confirmDiscard}>
            {isUntracked ? "Remove File" : "Discard Changes"}
          </button>
        </div>
      </div>
    {/if}
  </Modal>
</div>

{#snippet section(kind: ScmSectionKind, label: string, count: number, expanded: boolean, toggle: () => void, rows: GitFileEntry[])}
  <ScmSection id={kind} {label} {count} {expanded} onToggle={toggle} {rows} {kind} {scmStore}
    {collapsedFolders} {filterActive} onToggleFolder={toggleFolder} {onShowFileHistory}
    onRequestDiscard={requestDiscard} {onArchive} {onTrash} {onIgnore} />
{/snippet}

<style>
  .sidebar-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 20px;
    text-align: center;
    gap: 12px;
  }

  .empty-title {
    font-size: 13px;
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  .init-button {
    margin-top: 8px;
    padding: 8px 16px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .init-button:hover {
    background: color-mix(in srgb, var(--accent) 85%, black);
  }

  /* Fuzzy filter over the pending files (#517). Sits between the commit panel
     and the sections, matching the address-bar filter treatment. */
  .scm-filter {
    display: flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    margin: 8px 8px 4px;
    padding: 0 8px;
    height: 26px;
    background: var(--control-fill-secondary);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
  }

  .scm-filter:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .scm-filter-icon {
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .scm-filter-input {
    flex: 1;
    min-width: 0;
    padding: 2px 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 12px;
  }

  .scm-filter-input::placeholder {
    color: var(--text-tertiary);
  }

  .scm-filter-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .scm-filter-clear:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .scm-no-match {
    padding: 16px 12px;
    color: var(--text-tertiary);
    font-size: 12px;
    text-align: center;
  }

  .op-banner {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--divider);
    background: color-mix(in srgb, var(--system-caution, #f59e0b) 14%, var(--background-card));
    border-left: 3px solid var(--system-caution, #f59e0b);
  }

  .op-banner-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .op-banner-title {
    font-size: 12px;
    font-weight: var(--font-weight-semibold, 600);
    color: var(--text-primary);
  }

  .op-banner-detail {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .op-banner-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .op-banner-btn {
    height: 24px;
    padding: 0 10px;
    border-radius: var(--radius-sm, 4px);
    font-family: inherit;
    font-size: 11px;
    font-weight: var(--font-weight-medium, 500);
    cursor: pointer;
    border: 1px solid var(--divider);
    background: var(--background-card);
    color: var(--text-secondary);
    transition: background var(--transition-fast), opacity var(--transition-fast);
  }

  .op-banner-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-primary) 8%, var(--background-card));
  }

  .op-banner-btn.abort {
    border-color: color-mix(in srgb, var(--system-critical, #dc2626) 50%, var(--divider));
    color: var(--system-critical-text, var(--system-critical, #dc2626));
  }

  .op-banner-btn.continue {
    border-color: var(--accent);
    color: var(--accent-text, var(--accent));
  }

  .op-banner-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .loading-state {
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .skeleton-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .skeleton-block {
    height: 10px;
    border-radius: 5px;
    background: var(--subtle-fill-secondary, rgba(128, 128, 128, 0.15));
    animation: skeleton-pulse 1.2s ease-in-out var(--delay, 0ms) infinite;
  }

  .skeleton-letter {
    width: 10px;
    flex-shrink: 0;
  }

  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 1; }
  }

  .clean-state {
    padding: 24px 16px;
    color: var(--text-tertiary);
    font-size: 12px;
    text-align: center;
  }

  .scm-confirm-dialog {
    width: min(420px, 90vw);
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    padding: 20px 22px 18px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  }

  .scm-confirm-title {
    margin: 0 0 10px;
    font-size: 15px;
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .scm-confirm-body {
    margin: 0 0 16px;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .scm-confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .scm-confirm-btn {
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--divider);
    background: var(--background-card);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .scm-confirm-btn.danger {
    background: var(--system-critical, #dc2626);
    color: #fff;
    border-color: transparent;
  }

  .scm-confirm-btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
  }
</style>
