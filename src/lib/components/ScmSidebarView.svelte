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
  import { gitInit, gitAddToGitignore, gitArchiveUntracked, gitTrashUntracked } from "$lib/api/files";
  import { toastStore } from "$lib/state/toast.svelte";
  import { parentDir, basename } from "$lib/domain/path";
  import { settingsStore } from "$lib/state/settings.svelte";
  import {
    queueGraphFileHistory,
    requestGraphFileHistory,
  } from "$lib/state/git-graph-file-history";
  import type { GitFileEntry, GitStatusCode } from "$lib/api/files";
  import { gitOpStateLabel } from "$lib/domain/git";
  import Modal from "./Modal.svelte";

  import { buildTree, collectPaths, type ScmTreeNode } from "$lib/domain/scm-tree";
  import {
    filterScmSummary,
    isScmFilterActive,
    scmEmptyState,
    showScmFilterInput,
  } from "$lib/domain/scm-filter";

  // Per-pane store (#334): this view tracks the pane it is mounted in, so a
  // second pane on another repo gets its own independent SCM panel. Falls
  // back to a shared "default" store when mounted outside a pane.
  const paneId = getPaneIdContext() ?? "default";
  const scmStore = getScmStore(paneId);

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
  let pendingDiscard = $state<{ paths: string[]; isUntracked: boolean } | null>(null);
  let cancelButtonEl: HTMLButtonElement | undefined = $state();

  function requestDiscard(paths: string[], isUntracked: boolean): void {
    pendingDiscard = { paths, isUntracked };
    queueMicrotask(() => cancelButtonEl?.focus());
  }

  async function confirmDiscard(): Promise<void> {
    const target = pendingDiscard;
    pendingDiscard = null;
    if (!target) return;
    const r = await scmStore.discard(target.paths);
    if (!r.ok) {
      toastStore.error(`${target.isUntracked ? "Remove" : "Discard"} failed: ${r.error}`);
      return;
    }
    toastStore.success(
      target.isUntracked
        ? `Removed ${target.paths.length === 1 ? target.paths[0] : `${target.paths.length} files`}`
        : `Discarded changes in ${target.paths.length === 1 ? target.paths[0] : `${target.paths.length} files`}`,
    );
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

  function statusLetter(code: GitStatusCode): string {
    switch (code) {
      case "Modified": return "M";
      case "Added": return "A";
      case "Deleted": return "D";
      case "Renamed": return "R";
      case "Copied": return "C";
      case "Untracked": return "U";
      case "Ignored": return "I";
      case "Conflicted": return "!";
      case "TypeChange": return "T";
    }
  }

  function statusClass(code: GitStatusCode): string {
    switch (code) {
      case "Modified": return "s-modified";
      case "Added":
      case "Untracked": return "s-added";
      case "Deleted": return "s-deleted";
      case "Renamed":
      case "Copied": return "s-renamed";
      case "Conflicted": return "s-conflict";
      case "Ignored": return "s-ignored";
      case "TypeChange": return "s-type";
    }
  }

  function splitPath(path: string): { dir: string; name: string } {
    const idx = path.lastIndexOf("/");
    if (idx < 0) return { dir: "", name: path };
    return { dir: parentDir(path), name: basename(path) };
  }

  async function onInitRepo(): Promise<void> {
    const explorer = windowTabsManager.getExplorer(paneId) ?? windowTabsManager.getActiveExplorer();
    const path = explorer?.currentPath;
    if (!path) return;
    const r = await gitInit(path);
    if (!r.ok) {
      toastStore.error(`git init failed: ${r.error}`);
      return;
    }
    toastStore.show(`Initialized git repository at ${r.data}`, "success");
    await scmStore.setActivePath(path);
  }

  async function doCommit(opts?: { forceAmend?: boolean }): Promise<void> {
    const wasAmend = commitMode === "amend" || opts?.forceAmend;
    const result = await scmStore.commit(opts);
    if (result.ok) {
      toastStore.show(wasAmend ? "Amended last commit" : "Commit created", "success");
    }
  }

  function onCommitKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      if (e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      doCommit({ forceAmend: e.ctrlKey || e.metaKey });
    }
  }

  function onDiscard(row: GitFileEntry, isUntracked: boolean): void {
    requestDiscard([row.path], isUntracked);
  }

  /** Open this pane's graph and hand its repository-relative SCM path to the
   *  graph filter. The handoff is buffered until the view mounts (#518). */
  function onShowFileHistory(path: string): void {
    const repoRoot = scmStore.repoRoot;
    if (!repoRoot || !path.trim()) return;
    // If this pane holds a graph for another repo, its outgoing component is
    // still registered until Svelte remounts it. Queue instead of delivering
    // to that soon-to-be-destroyed handler.
    if (windowTabsManager.getPaneGitGraph(paneId) !== repoRoot) {
      queueGraphFileHistory(paneId, path);
      windowTabsManager.showGitGraphInPane(paneId, repoRoot);
      return;
    }
    windowTabsManager.showGitGraphInPane(paneId, repoRoot);
    requestGraphFileHistory(paneId, path);
  }

  async function onIgnore(path: string): Promise<void> {
    if (!scmStore.repoRoot) return;
    const r = await gitAddToGitignore(scmStore.repoRoot, path);
    if (!r.ok) {
      toastStore.error(`Ignore failed: ${r.error}`);
      return;
    }
    toastStore.success(`Added ${r.data} to .gitignore`);
    await scmStore.refresh();
  }

  async function onArchive(paths: string[]): Promise<void> {
    if (!scmStore.repoRoot) return;
    const r = await gitArchiveUntracked(scmStore.repoRoot, paths);
    if (!r.ok) {
      toastStore.error(`Archive failed: ${r.error}`);
      return;
    }
    toastStore.success(`Archived ${paths.length} item${paths.length === 1 ? "" : "s"} to .archive`);
    await scmStore.refresh();
  }

  async function onTrash(paths: string[]): Promise<void> {
    if (!scmStore.repoRoot) return;
    const r = await gitTrashUntracked(scmStore.repoRoot, paths);
    if (!r.ok) {
      await scmStore.refresh();
      toastStore.error(`Move to Trash failed: ${r.error}`);
      return;
    }
    toastStore.success(`Moved ${paths.length} item${paths.length === 1 ? "" : "s"} to Trash`);
    await scmStore.refresh();
  }

  /** File paths in visual order, walking the tree the same way the template
   *  renders it (subfolders first, then own files; collapsed subtrees skipped). */
  function visibleTreePaths(rows: GitFileEntry[]): string[] {
    function walk(node: ScmTreeNode): string[] {
      const out: string[] = [];
      for (const child of node.children.values()) {
        if (!collapsedFolders.has(child.fullDir)) out.push(...walk(child));
      }
      out.push(...node.files.map((f) => f.path));
      return out;
    }
    return walk(buildTree(rows));
  }

  /** Row paths in the order the user actually sees them: filtered summary,
   *  collapsed sections and collapsed tree folders excluded. */
  const visibleRowPaths = $derived.by(() => {
    const sections: Array<{ rows: GitFileEntry[]; expanded: boolean }> = [
      { rows: summary.merge, expanded: mergeExpanded },
      { rows: summary.staged, expanded: stagedExpanded },
      { rows: summary.changes, expanded: changesExpanded },
      { rows: summary.untracked, expanded: untrackedExpanded },
    ];
    const paths: string[] = [];
    for (const { rows, expanded } of sections) {
      if (!expanded) continue;
      paths.push(...(settingsStore.scmTreeView ? visibleTreePaths(rows) : rows.map((r) => r.path)));
    }
    return paths;
  });

  /** Move selection over the visible rows and move DOM focus with it so a
   *  subsequent Enter acts on the newly selected row. */
  function moveSelection(delta: 1 | -1): void {
    const rows = visibleRowPaths;
    if (rows.length === 0) return;
    const currentIdx = scmStore.selectedPath == null ? -1 : rows.indexOf(scmStore.selectedPath);
    const next = currentIdx < 0
      ? (delta > 0 ? 0 : rows.length - 1)
      : Math.max(0, Math.min(rows.length - 1, currentIdx + delta));
    const path = rows[next];
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

  async function onAbortOperation(): Promise<void> {
    const label = opLabel;
    const r = await scmStore.abortOperation();
    if (!r.ok) {
      toastStore.error(`Abort failed: ${r.error}`);
      return;
    }
    toastStore.success(`${label} aborted`);
  }

  async function onContinueRebase(): Promise<void> {
    const r = await scmStore.continueRebase();
    if (!r.ok) {
      toastStore.error(`Rebase continue failed: ${r.error}`);
      return;
    }
    toastStore.success("Rebase continued");
  }

  /** Whether the commit button should be active. Uses full (unfiltered) counts
   *  since commits operate repo-wide. Unresolved conflicts block every commit,
   *  mirroring git's own refusal while the index is unmerged. */
  const canCommit = $derived.by(() => {
    if (!isRepo) return false;
    if (fullMergeCount > 0) return false;
    const msg = scmStore.commitMessage.trim();
    if (scmStore.amend) return true;
    const hasStaged = fullStagedCount > 0;
    return msg.length > 0 && hasStaged;
  });

  const commitMode = $derived.by(() => {
    if (scmStore.amend) return "amend";
    return "commit";
  });

  const commitButtonLabel = $derived(
    commitMode === "amend" ? "Commit (Amend)" : "Commit"
  );

  const commitButtonTooltip = $derived(
    commitMode === "amend"
      ? "Amend the previous commit using this message"
      : "Create a new commit (Ctrl+Enter with empty message to amend)"
  );
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
    <div class="commit-panel">
      <div class="branch-line">
        <span class="branch-icon" aria-hidden="true">⌥</span>
        {#if summary.detached}
          <span class="branch-name detached" title="detached HEAD">HEAD@{summary.branch}</span>
        {:else}
          <span class="branch-name">{summary.branch ?? "main"}</span>
        {/if}
        <button
          type="button"
          class="view-toggle"
          aria-pressed={settingsStore.scmTreeView}
          title={settingsStore.scmTreeView ? "Switch to flat list" : "Switch to tree view"}
          onclick={() => settingsStore.toggleScmTreeView()}
        >
          {settingsStore.scmTreeView ? "Tree" : "List"}
        </button>
      </div>
      <textarea
        class="commit-message"
        placeholder={scmStore.amend
          ? "Amend commit message (optional)"
          : "Message (Enter to commit, Ctrl+Enter to amend)"}
        value={scmStore.commitMessage}
        oninput={(e) => scmStore.setCommitMessage((e.target as HTMLTextAreaElement).value)}
        onkeydown={onCommitKeydown}
        rows="2"
        aria-label="Commit message"
      ></textarea>
      {#if scmStore.commitError}
        <div class="commit-error" role="alert">{scmStore.commitError}</div>
      {/if}
      <div class="commit-row">
        <label class="amend-toggle">
          <input
            type="checkbox"
            checked={scmStore.amend}
            onchange={(e) => scmStore.setAmend((e.target as HTMLInputElement).checked)}
          />
          <span>Amend</span>
        </label>
        <button
          type="button"
          class="commit-btn"
          disabled={!canCommit}
          onclick={() => doCommit()}
          title={commitButtonTooltip}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="commit-btn-icon">
            <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {commitButtonLabel}
        </button>
      </div>
    </div>

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
      {@render section({
        id: "merge",
        label: "Merge Changes",
        count: mergeCount,
        expanded: mergeExpanded,
        toggle: () => (mergeExpanded = !mergeExpanded),
        rows: summary.merge,
        kind: "merge",
      })}
    {/if}

    {@render section({
      id: "staged",
      label: "Staged Changes",
      count: stagedCount,
      expanded: stagedExpanded,
      toggle: () => (stagedExpanded = !stagedExpanded),
      rows: summary.staged,
      kind: "staged",
    })}

    {@render section({
      id: "changes",
      label: "Changes",
      count: changesCount,
      expanded: changesExpanded,
      toggle: () => (changesExpanded = !changesExpanded),
      rows: summary.changes,
      kind: "changes",
    })}

    {@render section({
      id: "untracked",
      label: "Untracked",
      count: untrackedCount,
      expanded: untrackedExpanded,
      toggle: () => (untrackedExpanded = !untrackedExpanded),
      rows: summary.untracked,
      kind: "untracked",
    })}

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

{#snippet section(opts: { id: string; label: string; count: number; expanded: boolean; toggle: () => void; rows: GitFileEntry[]; kind: "staged" | "changes" | "untracked" | "merge" })}
  <div class="section" data-section={opts.id}>
    <button
      type="button"
      class="section-header"
      onclick={opts.toggle}
      aria-expanded={opts.expanded}
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={opts.expanded}>
        <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="section-label">{opts.label}</span>
      <span class="count-badge">{opts.count}</span>
    </button>

    {#if opts.expanded}
      {#if settingsStore.scmTreeView}
        {@const tree = buildTree(opts.rows)}
        {@render treeNode(tree, 0, opts.kind)}
      {:else}
      <ul class="row-list" role="listbox" aria-label="{opts.kind} files">
        {#each opts.rows as row (row.path)}
          {@const parts = splitPath(row.path)}
          <li
            class="row"
            class:selected={scmStore.selectedPath === row.path}
            class:active-diff={scmStore.activeDiff?.path === row.path}
            data-path={row.path}
            data-section-kind={opts.kind}
            tabindex="0"
            onclick={() => { scmStore.setSelected(row.path); scmStore.openDiff(row.path, opts.kind === 'staged'); settingsStore.openPreviewPane(); }}
            onkeydown={(e) => { if (e.key === 'Enter') { scmStore.setSelected(row.path); scmStore.openDiff(row.path, opts.kind === 'staged'); settingsStore.openPreviewPane(); } }}
            role="option"
            aria-selected={scmStore.selectedPath === row.path}
            title={row.path}
          >
            <span class="file-name">{parts.name}</span>
            {#if parts.dir}
              <span class="file-dir">{parts.dir}</span>
            {/if}
            <span class="row-actions">
              <button
                type="button"
                class="row-btn"
                title="Show history for this file"
                aria-label="Show history for {row.path}"
                onclick={(e) => { e.stopPropagation(); onShowFileHistory(row.path); }}
              >{@render actionIcon("history")}</button>
              {#if opts.kind === "staged"}
                <button
                  type="button"
                  class="row-btn"
                  title="Unstage"
                  aria-label="Unstage {row.path}"
                  onclick={(e) => { e.stopPropagation(); scmStore.unstage([row.path]); }}
                >{@render actionIcon("unstage")}</button>
              {:else if opts.kind === "merge"}
                <button
                  type="button"
                  class="row-btn"
                  title="Stage"
                  aria-label="Stage {row.path}"
                  onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}
                >{@render actionIcon("stage")}</button>
              {:else}
                <button
                  type="button"
                  class="row-btn destructive"
                  title={opts.kind === "untracked" ? "Remove file" : "Discard changes"}
                  aria-label={opts.kind === "untracked" ? `Remove ${row.path}` : `Discard ${row.path}`}
                  onclick={(e) => { e.stopPropagation(); onDiscard(row, opts.kind === "untracked"); }}
                >{@render actionIcon("discard")}</button>
                {#if opts.kind === "untracked"}
                  <button type="button" class="row-btn" title="Archive to .archive" aria-label="Archive {row.path} to .archive"
                    onclick={(e) => { e.stopPropagation(); onArchive([row.path]); }}>{@render actionIcon("archive")}</button>
                  <button type="button" class="row-btn" title="Move to Trash" aria-label="Move {row.path} to Trash"
                    onclick={(e) => { e.stopPropagation(); onTrash([row.path]); }}>{@render actionIcon("trash")}</button>
                  <button
                    type="button"
                    class="row-btn"
                    title="Add to .gitignore"
                    aria-label="Ignore {row.path}"
                    onclick={(e) => { e.stopPropagation(); onIgnore(row.path); }}
                  >{@render actionIcon("ignore")}</button>
                {/if}
                <button
                  type="button"
                  class="row-btn"
                  title="Stage"
                  aria-label="Stage {row.path}"
                  onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}
                >{@render actionIcon("stage")}</button>
              {/if}
            </span>
            <span class="status-letter {statusClass(row.status)}" aria-label={row.status}>
              {statusLetter(row.status)}
            </span>
          </li>
        {/each}
      </ul>
      {/if}
    {/if}
  </div>
{/snippet}

<!-- Row action icons as SVGs: the previous text glyphs (− + ↺ ⊘) rendered at
     inconsistent sizes because their font metrics differ wildly at the same
     font-size — ↺ in particular drew visibly larger than the rest (#270). -->
{#snippet actionIcon(kind: "stage" | "unstage" | "discard" | "ignore" | "archive" | "trash" | "history")}
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if kind === "stage"}
      <path d="M8 3.5v9M3.5 8h9" />
    {:else if kind === "unstage"}
      <path d="M3.5 8h9" />
    {:else if kind === "discard"}
      <path d="M6.5 3.5L3.5 6l3 2.5" />
      <path d="M3.5 6h5a3.25 3.25 0 0 1 0 6.5H6.5" />
    {:else if kind === "archive"}
      <path d="M2.5 5.5h11v7h-11zM4 3.5h8v2H4z" />
      <path d="M6.25 8.5h3.5" />
    {:else if kind === "trash"}
      <path d="M3.5 5h9M6 5V3.5h4V5M5 5l.5 8h5l.5-8M7 7.5v3M9 7.5v3" />
    {:else if kind === "history"}
      <circle cx="8" cy="8" r="5" />
      <path d="M8 5v3l2 1.5" />
    {:else}
      <circle cx="8" cy="8" r="5" />
      <path d="M4.7 4.7l6.6 6.6" />
    {/if}
  </svg>
{/snippet}

{#snippet treeNode(node: ScmTreeNode, depth: number, kind: "staged" | "changes" | "untracked" | "merge")}
  <ul class="row-list tree-list" role={depth === 0 ? "tree" : "group"} style="padding-left: {depth === 0 ? 4 : 0}px">
    {#each Array.from(node.children.values()) as child (child.fullDir)}
      {@const collapsed = collapsedFolders.has(child.fullDir)}
      {@const folderPaths = collectPaths(child)}
      <li
        class="row tree-folder"
        style="padding-left: {depth * 12 + 4}px"
        tabindex="0"
        onclick={() => toggleFolder(child.fullDir)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder(child.fullDir); } }}
        role="treeitem"
        aria-expanded={!collapsed}
        aria-selected="false"
        aria-disabled={filterActive}
      >
        {#each { length: depth } as _, i}
          <span class="depth-guide" style="left: {i * 12 + 10}px"></span>
        {/each}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={!collapsed}>
          <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="folder-name">{child.name}</span>
        <span class="row-actions folder-actions">
          {#if kind === "staged"}
            <button type="button" class="row-btn" title="Unstage folder" aria-label="Unstage {child.name}"
              onclick={(e) => { e.stopPropagation(); scmStore.unstage(folderPaths); }}>{@render actionIcon("unstage")}</button>
          {:else if kind === "merge"}
            <button type="button" class="row-btn" title="Stage folder" aria-label="Stage {child.name}"
              onclick={(e) => { e.stopPropagation(); scmStore.stage(folderPaths); }}>{@render actionIcon("stage")}</button>
          {:else}
            <button type="button" class="row-btn destructive"
              title={kind === "untracked" ? "Remove folder" : "Discard folder changes"}
              aria-label={kind === "untracked" ? `Remove ${child.name}` : `Discard ${child.name}`}
              onclick={(e) => { e.stopPropagation(); requestDiscard(folderPaths, kind === "untracked"); }}>{@render actionIcon("discard")}</button>
            {#if kind === "untracked"}
              <button type="button" class="row-btn" title="Archive to .archive" aria-label="Archive {child.name} to .archive"
                onclick={(e) => { e.stopPropagation(); onArchive(folderPaths); }}>{@render actionIcon("archive")}</button>
              <button type="button" class="row-btn" title="Move to Trash" aria-label="Move {child.name} to Trash"
                onclick={(e) => { e.stopPropagation(); onTrash(folderPaths); }}>{@render actionIcon("trash")}</button>
              <button type="button" class="row-btn" title="Add folder to .gitignore" aria-label="Ignore {child.name}"
                onclick={(e) => { e.stopPropagation(); onIgnore(child.fullDir); }}>{@render actionIcon("ignore")}</button>
            {/if}
            <button type="button" class="row-btn" title="Stage folder" aria-label="Stage {child.name}"
              onclick={(e) => { e.stopPropagation(); scmStore.stage(folderPaths); }}>{@render actionIcon("stage")}</button>
          {/if}
        </span>
      </li>
      {#if !collapsed}
        {@render treeNode(child, depth + 1, kind)}
      {/if}
    {/each}
    {#each node.files as row (row.path)}
      {@const fileName = basename(row.path)}
      <li
        class="row tree-file"
        class:selected={scmStore.selectedPath === row.path}
        class:active-diff={scmStore.activeDiff?.path === row.path}
        data-path={row.path}
        data-section-kind={kind}
        style="padding-left: {depth * 12 + 4}px"
        tabindex="0"
        onclick={() => { scmStore.setSelected(row.path); scmStore.openDiff(row.path, kind === 'staged'); settingsStore.openPreviewPane(); }}
        onkeydown={(e) => { if (e.key === 'Enter') { scmStore.setSelected(row.path); scmStore.openDiff(row.path, kind === 'staged'); settingsStore.openPreviewPane(); } }}
        role="treeitem"
        aria-selected={scmStore.selectedPath === row.path}
        title={row.path}
      >
        {#each { length: depth } as _, i}
          <span class="depth-guide" style="left: {i * 12 + 10}px"></span>
        {/each}
        <span class="file-name">{fileName}</span>
        <span class="row-actions">
          <button type="button" class="row-btn" title="Show history for this file" aria-label="Show history for {row.path}"
            onclick={(e) => { e.stopPropagation(); onShowFileHistory(row.path); }}>{@render actionIcon("history")}</button>
          {#if kind === "staged"}
            <button type="button" class="row-btn" title="Unstage" aria-label="Unstage {row.path}"
              onclick={(e) => { e.stopPropagation(); scmStore.unstage([row.path]); }}>{@render actionIcon("unstage")}</button>
          {:else if kind === "merge"}
            <button type="button" class="row-btn" title="Stage" aria-label="Stage {row.path}"
              onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}>{@render actionIcon("stage")}</button>
          {:else}
            <button type="button" class="row-btn destructive"
              title={kind === "untracked" ? "Remove file" : "Discard changes"}
              aria-label={kind === "untracked" ? `Remove ${row.path}` : `Discard ${row.path}`}
              onclick={(e) => { e.stopPropagation(); onDiscard(row, kind === "untracked"); }}>{@render actionIcon("discard")}</button>
            {#if kind === "untracked"}
              <button type="button" class="row-btn" title="Archive to .archive" aria-label="Archive {row.path} to .archive"
                onclick={(e) => { e.stopPropagation(); onArchive([row.path]); }}>{@render actionIcon("archive")}</button>
              <button type="button" class="row-btn" title="Move to Trash" aria-label="Move {row.path} to Trash"
                onclick={(e) => { e.stopPropagation(); onTrash([row.path]); }}>{@render actionIcon("trash")}</button>
              <button type="button" class="row-btn" title="Add to .gitignore" aria-label="Ignore {row.path}"
                onclick={(e) => { e.stopPropagation(); onIgnore(row.path); }}>{@render actionIcon("ignore")}</button>
            {/if}
            <button type="button" class="row-btn" title="Stage" aria-label="Stage {row.path}"
              onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}>{@render actionIcon("stage")}</button>
          {/if}
        </span>
        <span class="status-letter {statusClass(row.status)}" aria-label={row.status}>
          {statusLetter(row.status)}
        </span>
      </li>
    {/each}
  </ul>
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

  .commit-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--divider);
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

  /* Collapsing is disabled while filtering (every folder renders expanded),
     so the row should not advertise a click that does nothing. */
  .row.tree-folder[aria-disabled="true"] {
    cursor: default;
  }

  .scm-no-match {
    padding: 16px 12px;
    color: var(--text-tertiary);
    font-size: 12px;
    text-align: center;
  }

  .branch-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
    font-weight: var(--font-weight-semibold);
  }

  .branch-name {
    color: var(--text-secondary);
    text-transform: none;
    letter-spacing: var(--letter-spacing-normal);
  }

  .branch-name.detached {
    color: var(--system-warning, #f59e0b);
  }

  .view-toggle {
    margin-left: auto;
    padding: 2px 8px;
    background: var(--background-card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .view-toggle:hover {
    background: var(--subtle-fill-secondary);
  }

  .view-toggle[aria-pressed="true"] {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    border-color: var(--accent);
  }

  .tree-list {
    padding: 0 4px;
    gap: 0;
  }

  .row.tree-folder {
    gap: 4px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
    height: 22px;
    min-height: 22px;
    position: relative;
  }

  .row.tree-folder .folder-actions {
    opacity: 0;
  }

  .row.tree-folder:hover .folder-actions {
    opacity: 1;
  }

  .folder-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.tree-file {
    position: relative;
  }

  .depth-guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--divider);
    pointer-events: none;
  }

  .commit-message {
    width: 100%;
    min-height: 52px;
    padding: 8px 10px;
    background: var(--control-fill);
    border: 1px solid var(--divider);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
    transition: border-color var(--transition-fast);
  }

  .commit-message::placeholder {
    color: var(--text-tertiary);
  }

  .commit-message:focus {
    outline: none;
    border-color: var(--accent);
  }

  .commit-error {
    font-size: 11px;
    color: var(--system-critical, #dc2626);
    padding: 2px 4px;
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
    color: var(--system-critical, #dc2626);
  }

  .op-banner-btn.continue {
    border-color: var(--accent);
    color: var(--accent);
  }

  .op-banner-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .commit-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .amend-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }

  .amend-toggle input {
    accent-color: var(--accent);
  }

  .commit-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    height: 26px;
    padding: 0 14px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity var(--transition-fast), background var(--transition-fast);
  }

  .commit-btn-icon {
    flex-shrink: 0;
  }

  .commit-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, black);
  }

  .commit-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .section {
    display: flex;
    flex-direction: column;
    padding: 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    background: transparent;
    border: none;
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
    cursor: pointer;
    text-align: left;
    width: 100%;
    transition: background var(--transition-fast);
  }

  .section-header:hover {
    background: var(--subtle-fill-secondary);
  }

  .chevron {
    flex-shrink: 0;
    color: var(--text-tertiary);
    transition: transform var(--transition-fast);
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .section-label {
    flex: 1;
  }

  .count-badge {
    background: var(--subtle-fill-secondary);
    color: var(--text-secondary);
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: var(--font-weight-medium);
    letter-spacing: 0;
    text-transform: none;
  }

  .row-list {
    list-style: none;
    margin: 0;
    padding: 0 4px 4px;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
    font-size: 13px;
    height: 22px;
    min-height: 22px;
    position: relative;
  }

  .row:hover {
    background: var(--subtle-fill-secondary);
  }

  .row.selected {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .row.active-diff {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    font-weight: var(--font-weight-medium);
  }

  .row:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .status-letter {
    flex-shrink: 0;
    width: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: var(--font-weight-bold);
    font-size: 11px;
    text-align: center;
    line-height: 1;
    margin-left: auto;
  }

  /* Status letter colors: themeable via --scm-* vars, mixed with the theme's
     text color so they stay legible on both dark and light backgrounds. */
  .s-modified { color: var(--scm-modified, color-mix(in srgb, #d7ba7d 75%, var(--text-primary) 25%)); }
  .s-added { color: var(--scm-added, color-mix(in srgb, #73c991 75%, var(--text-primary) 25%)); }
  .s-deleted { color: var(--scm-deleted, color-mix(in srgb, #f14c4c 75%, var(--text-primary) 25%)); }
  .s-renamed { color: var(--scm-renamed, color-mix(in srgb, #6cb6ff 75%, var(--text-primary) 25%)); }
  .s-conflict { color: var(--scm-conflict, color-mix(in srgb, #e4676b 75%, var(--text-primary) 25%)); }
  .s-ignored { color: var(--text-tertiary); }
  .s-type { color: var(--scm-typechange, color-mix(in srgb, #eab308 75%, var(--text-primary) 25%)); }

  .file-name {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-dir {
    flex-shrink: 1;
    color: var(--text-tertiary);
    font-size: 90%;
    margin-left: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    min-width: 0;
  }

  .row-actions {
    display: none;
    gap: 2px;
    position: absolute;
    right: 16px;
    top: 0;
    bottom: 0;
    align-items: center;
    padding: 0 4px 0 16px;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: linear-gradient(to right, transparent 0%, var(--subtle-fill-secondary) 30%);
  }

  .folder-actions {
    right: 0;
  }

  .row:hover .row-actions,
  .row:focus-within .row-actions,
  .row.selected .row-actions {
    display: flex;
  }

  .row:hover .file-dir,
  .row:focus-within .file-dir,
  .row.selected .file-dir {
    display: none;
  }

  .row-btn {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transition:
      color var(--transition-fast),
      background-color var(--transition-fast);
  }

  /* A color-only hover read as barely-there (#270): give the hovered button
     a visible pill so it's obvious which action the cursor is on. */
  .row-btn:hover {
    color: var(--text-primary);
    background: var(--control-fill-secondary, rgba(128, 128, 128, 0.22));
  }

  .row-btn:active {
    background: var(--control-fill-tertiary, rgba(128, 128, 128, 0.32));
  }

  .row-btn.destructive:hover {
    color: var(--error, #e5534b);
    background: color-mix(in srgb, var(--error, #e5534b) 15%, transparent);
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
