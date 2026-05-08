<!--
  ScmSidebarView - Source Control panel (#54).

  Sections: Merge / Staged / Changes / Untracked — each collapsible with a
  count badge. Each row carries hover actions (stage, unstage, discard).
  Commit input at the top with amend toggle and inline validation. Empty
  state when the active pane is not inside a git repo. Auto-refreshes on
  the `git-status-changed` watcher event.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { scmStore } from "$lib/state/scm.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { gitInit } from "$lib/api/files";
  import { toastStore } from "$lib/state/toast.svelte";
  import type { GitFileEntry, GitStatusCode } from "$lib/api/files";

  let commitInputEl: HTMLTextAreaElement | undefined;
  let rootEl: HTMLDivElement | undefined;

  let stagedExpanded = $state(true);
  let changesExpanded = $state(true);
  let untrackedExpanded = $state(true);
  let mergeExpanded = $state(true);

  // Pending confirmation for destructive Discard/Remove actions. Shown as
  // an inline overlay; Esc cancels, Cancel is the default-focused button.
  let pendingDiscard = $state<{ paths: string[]; isUntracked: boolean } | null>(null);
  let cancelButtonEl: HTMLButtonElement | undefined;

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

  function onConfirmKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") { e.preventDefault(); cancelDiscard(); }
  }

  onMount(() => {
    scmStore.initWatcherListener();
    const active = windowTabsManager.getActiveExplorer();
    if (active?.currentPath) scmStore.setActivePath(active.currentPath);
  });

  // Track active explorer path → repo root resolution. Genuine side effect
  // (async IPC + watcher registration), so $effect is appropriate here.
  $effect(() => {
    const active = windowTabsManager.getActiveExplorer();
    const path = active?.currentPath;
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
    return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
  }

  async function onInitRepo(): Promise<void> {
    const active = windowTabsManager.getActiveExplorer();
    const path = active?.currentPath;
    if (!path) return;
    const r = await gitInit(path);
    if (!r.ok) {
      toastStore.error(`git init failed: ${r.error}`);
      return;
    }
    toastStore.show(`Initialized git repository at ${r.data}`, "success");
    await scmStore.setActivePath(path);
  }

  async function doCommit(): Promise<void> {
    const mode = commitMode;
    const result = await scmStore.commit();
    if (result.ok) {
      toastStore.show(
        mode === "amend" || mode === "amend-no-edit" ? "Amended last commit" : "Commit created",
        "success",
      );
    }
  }

  function onCommitKeydown(e: KeyboardEvent): void {
    // Ctrl+Enter always commits. Bare Enter commits unless Shift is held
    // (Shift+Enter inserts a newline).
    if (e.key === "Enter") {
      if (e.shiftKey) return;
      e.preventDefault();
      doCommit();
    }
  }

  function onDiscard(row: GitFileEntry, isUntracked: boolean): void {
    requestDiscard([row.path], isUntracked);
  }

  function onRowKeydown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      scmStore.moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      scmStore.moveSelection(-1);
    }
  }

  const summary = $derived(scmStore.summary);
  const isRepo = $derived(summary.is_repo);

  const stagedCount = $derived(summary.staged.length);
  const changesCount = $derived(summary.changes.length);
  const untrackedCount = $derived(summary.untracked.length);
  const mergeCount = $derived(summary.merge.length);

  /** Whether the commit button should be active. Allowed when either:
   *  - the user has typed a message AND something is staged or amend is on
   *  - the message is empty but staged files exist (button performs amend-no-edit)
   *  - amend toggle is on (regardless of message) */
  const canCommit = $derived.by(() => {
    if (!isRepo) return false;
    const msg = scmStore.commitMessage.trim();
    if (scmStore.amend) return true;
    const hasStaged = stagedCount > 0 || mergeCount > 0;
    if (msg.length > 0) return hasStaged;
    return hasStaged; // empty msg + staged → implicit amend-no-edit
  });

  /** Mode the commit button will fire in, used for label + tooltip. */
  const commitMode = $derived.by(() => {
    if (scmStore.amend) return "amend";
    const msg = scmStore.commitMessage.trim();
    if (msg.length === 0 && (stagedCount > 0 || mergeCount > 0)) return "amend-no-edit";
    return "commit";
  });

  const commitButtonLabel = $derived(
    commitMode === "amend"
      ? "Commit (Amend)"
      : commitMode === "amend-no-edit"
        ? "Amend (no edit)"
        : "Commit"
  );

  const commitButtonTooltip = $derived(
    commitMode === "amend"
      ? "Amend the previous commit using this message"
      : commitMode === "amend-no-edit"
        ? "Empty message — staged files will be added to the previous commit (git commit --amend --no-edit)"
        : "Create a new commit"
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="sidebar-view scm-view" bind:this={rootEl} onkeydown={onRowKeydown} role="presentation">
  {#if !isRepo}
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
    <div class="commit-panel">
      <div class="branch-line">
        <span class="branch-icon" aria-hidden="true">⌥</span>
        {#if summary.detached}
          <span class="branch-name detached" title="detached HEAD">HEAD@{summary.branch}</span>
        {:else}
          <span class="branch-name">{summary.branch ?? "main"}</span>
        {/if}
      </div>
      <textarea
        bind:this={commitInputEl}
        class="commit-message"
        placeholder={scmStore.amend
          ? "Amend commit message (optional)"
          : ((stagedCount > 0 || mergeCount > 0)
              ? "Message — leave empty + Enter to amend the previous commit"
              : "Message (Enter to commit, Shift+Enter to add a newline)")}
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
          onclick={doCommit}
          title={commitButtonTooltip}
        >
          {commitButtonLabel}
        </button>
      </div>
    </div>

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

    {#if stagedCount + changesCount + untrackedCount + mergeCount === 0}
      <div class="clean-state">Working tree clean</div>
    {/if}
  {/if}

  {#if pendingDiscard}
    {@const isUntracked = pendingDiscard.isUntracked}
    {@const count = pendingDiscard.paths.length}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="scm-confirm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="scm-confirm-title"
      onclick={(e) => { if (e.target === e.currentTarget) cancelDiscard(); }}
      onkeydown={onConfirmKeydown}
    >
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
    </div>
  {/if}
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
      <ul class="row-list" role="list">
        {#each opts.rows as row (row.path)}
          {@const parts = splitPath(row.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            class="row"
            class:selected={scmStore.selectedPath === row.path}
            class:active-diff={scmStore.activeDiff?.path === row.path}
            data-path={row.path}
            data-section-kind={opts.kind}
            tabindex="0"
            onclick={() => { scmStore.setSelected(row.path); scmStore.openDiff(row.path, opts.kind === 'staged'); }}
            onkeydown={(e) => { if (e.key === 'Enter') { scmStore.setSelected(row.path); scmStore.openDiff(row.path, opts.kind === 'staged'); } }}
            role="listitem"
            title={row.path}
          >
            <span class="status-letter {statusClass(row.status)}" aria-label={row.status}>
              {statusLetter(row.status)}
            </span>
            <span class="file-name">{parts.name}</span>
            {#if parts.dir}
              <span class="file-dir">{parts.dir}</span>
            {/if}
            <span class="row-actions">
              {#if opts.kind === "staged"}
                <button
                  type="button"
                  class="row-btn"
                  title="Unstage"
                  aria-label="Unstage {row.path}"
                  onclick={(e) => { e.stopPropagation(); scmStore.unstage([row.path]); }}
                >−</button>
              {:else if opts.kind === "merge"}
                <button
                  type="button"
                  class="row-btn"
                  title="Stage"
                  aria-label="Stage {row.path}"
                  onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}
                >+</button>
              {:else}
                <button
                  type="button"
                  class="row-btn"
                  title={opts.kind === "untracked" ? "Remove file" : "Discard changes"}
                  aria-label={opts.kind === "untracked" ? `Remove ${row.path}` : `Discard ${row.path}`}
                  onclick={(e) => { e.stopPropagation(); onDiscard(row, opts.kind === "untracked"); }}
                >↺</button>
                <button
                  type="button"
                  class="row-btn"
                  title="Stage"
                  aria-label="Stage {row.path}"
                  onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}
                >+</button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
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
    padding: 10px 12px 12px;
    border-bottom: 1px solid var(--divider);
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

  .commit-message {
    width: 100%;
    min-height: 52px;
    padding: 8px 10px;
    background: var(--background-card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
    transition: border-color var(--transition-fast);
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

  .commit-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
    padding: 6px 14px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: opacity var(--transition-fast), background var(--transition-fast);
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
    gap: 6px;
    padding: 6px 12px;
    background: transparent;
    border: none;
    font-family: inherit;
    font-size: var(--font-size-caption);
    font-weight: var(--font-weight-semibold);
    color: var(--text-tertiary);
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
    font-size: 10px;
    padding: 1px 7px;
    border-radius: var(--radius-pill);
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
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) minmax(0, auto);
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
    font-size: 13px;
    min-height: 26px;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: var(--font-weight-bold);
    font-size: 11px;
    text-align: center;
    line-height: 1;
  }

  .s-modified { color: #0ea5e9; }
  .s-added { color: #22c55e; }
  .s-deleted { color: #ef4444; }
  .s-renamed { color: #a855f7; }
  .s-conflict { color: #f97316; }
  .s-ignored { color: var(--text-tertiary); }
  .s-type { color: #eab308; }

  .file-name {
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-dir {
    grid-column: 3;
    color: var(--text-tertiary);
    font-size: 11px;
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
    grid-column: 3;
  }

  /* On hover/focus, show inline action buttons in the same slot the folder
     path used to occupy, so the row height never reflows to two lines. */
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
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 14px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: inherit;
    line-height: 1;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .row-btn:hover {
    background: var(--subtle-fill-tertiary);
    color: var(--text-primary);
  }

  .clean-state {
    padding: 24px 16px;
    color: var(--text-tertiary);
    font-size: 12px;
    text-align: center;
  }

  .scm-confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
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
