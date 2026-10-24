<!--
  GitGraphBranchFilter — the header's branch-filter button and popover
  (#342): fork-point lookup (#1083), file-path commit filter (#529), local-
  only (#381) and remote-only (#515) toggles, author batch toggles (#411,
  #412) and per-branch checkboxes (#413). Selection semantics are pure
  (domain/git-graph-branch-filter); the parent applies every change.
-->
<script lang="ts">
  import { remoteOnlyBranchNames } from "$lib/domain/git-graph";
  import {
    authorOptions as authorOptionsOf,
    branchesByAuthor,
    branchRef,
    filterBranchesByQuery,
    isAuthorShown as authorShown,
    isBranchShown as branchShown,
    toggleAllBranchesFilter,
    toggleAuthorInFilter,
    toggleBranchInFilter,
  } from "$lib/domain/git-graph-branch-filter";
  import type { GitGraphBranches } from "$lib/state/git-graph-branches.svelte";
  import type { GitGraphHistoryFilter } from "$lib/state/git-graph-history-filter.svelte";

  interface Props {
    open: boolean;
    /** Popover inputs are owned by the parent so they survive this
     *  component remounting across a load-error recovery. */
    branchQuery: string;
    firstMergeBranch: string;
    secondMergeBranch: string;
    branchSession: GitGraphBranches;
    filter: GitGraphHistoryFilter;
    onToggle: () => void;
    onFilePathInput: (event: Event) => void;
    onToggleLocalOnly: () => void;
    onToggleHideRemoteOnly: () => void;
    onSetBranchFilter: (next: string[] | null) => void;
    onJumpToMergeBase: (firstRef: string, secondRef: string) => void;
  }

  let {
    open = $bindable(),
    branchQuery = $bindable(),
    firstMergeBranch = $bindable(),
    secondMergeBranch = $bindable(),
    branchSession, filter, onToggle, onFilePathInput, onToggleLocalOnly,
    onToggleHideRemoteOnly, onSetBranchFilter, onJumpToMergeBase,
  }: Props = $props();

  const branchList = $derived(branchSession.branches);
  const branchAuthors = $derived(branchSession.authors);
  const authorOptions = $derived(authorOptionsOf(branchAuthors));
  const filteredBranchList = $derived(filterBranchesByQuery(branchList, branchQuery));
  /** Remote refs no local branch tracks — the set the bulk toggle hides. */
  const remoteOnlySet = $derived(new Set(remoteOnlyBranchNames(branchList)));
  const allBranchesShown = $derived(filter.branchFilter === null);

  function isHiddenAsRemoteOnly(name: string): boolean {
    return filter.hideRemoteOnly && remoteOnlySet.has(name);
  }

  function isBranchShown(name: string): boolean {
    return branchShown(name, filter.branchFilter, isHiddenAsRemoteOnly(name));
  }

  function authorBranches(author: string): string[] {
    return branchesByAuthor(branchList, branchAuthors, author, isHiddenAsRemoteOnly);
  }

  const allNames = () => branchList.map((b) => b.name);
</script>

<button
  class="branch-filter-btn"
  class:filtered={filter.active}
  onclick={onToggle}
  title="Filter branches"
  aria-label="Filter branches"
  data-testid="branch-filter-btn"
>
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.7" />
    <circle cx="4.5" cy="12.5" r="1.7" />
    <circle cx="11.5" cy="6" r="1.7" />
    <path d="M4.5 5.2v5.6 M11.5 7.7c0 2.6-4.5 1.8-7 3.4" />
  </svg>
  {#if filter.branchFilter}<span class="bf-count">{filter.branchFilter.length}</span>{/if}
</button>
{#if open}
  <button
    class="menu-backdrop"
    aria-label="Close branch filter"
    onclick={() => (open = false)}
  ></button>
  <div class="branch-popover" data-testid="branch-popover">
    <div class="bf-heading">Fork point</div>
    <div class="bf-fork-controls">
      <select aria-label="First merge-base branch" bind:value={firstMergeBranch} onchange={() => branchSession.cancelMergeBase()}>
        <option value="">First branch…</option>
        {#each branchList as branch (branchRef(branch))}
          <option value={branchRef(branch)}>{branch.name}{branch.remote ? " (remote)" : ""}</option>
        {/each}
      </select>
      <select aria-label="Second merge-base branch" bind:value={secondMergeBranch} onchange={() => branchSession.cancelMergeBase()}>
        <option value="">Second branch…</option>
        {#each branchList as branch (branchRef(branch))}
          <option value={branchRef(branch)}>{branch.name}{branch.remote ? " (remote)" : ""}</option>
        {/each}
      </select>
      <button class="prompt-btn" disabled={!firstMergeBranch || !secondMergeBranch || firstMergeBranch === secondMergeBranch || branchSession.mergeBaseBusy} onclick={() => onJumpToMergeBase(firstMergeBranch, secondMergeBranch)}>
        {branchSession.mergeBaseBusy ? "Finding merge-base…" : "Jump to merge-base"}
      </button>
      <span class="bf-fork-hint">Shows all branches and clears history filters.</span>
      {#if branchSession.mergeBaseError}<span role="alert" class="bf-fork-error">{branchSession.mergeBaseError}</span>{/if}
    </div>
    <div class="bf-heading">Commits</div>
    <input
      class="bf-path-search"
      placeholder="Filter commits by file path…"
      aria-label="Filter commits by file path"
      data-testid="git-graph-file-path-filter"
      value={filter.filePath}
      oninput={onFilePathInput}
    />
    <div class="bf-heading">Branches</div>
    <!-- svelte-ignore a11y_autofocus -- opened by explicit user action; focus goes where they're about to type -->
    <input
      class="bf-search"
      placeholder="Filter branches…"
      bind:value={branchQuery}
      autofocus
    />
    <div class="bf-list">
      <label class="bf-row bf-local-only" title="Hide history reachable only from remote-tracking branches">
        <input type="checkbox" checked={filter.localOnly} onchange={onToggleLocalOnly} />
        <span class="bf-name">Local branches only</span>
      </label>
      <!-- Bulk hide of remote refs no local branch tracks (#515). Not a
           `.bf-row`: the branch-row selectors below (and in e2e) address
           real branches only. -->
      <label
        class="bf-opt"
        title="Hide every remote branch that has no local counterpart"
        data-testid="bf-hide-remote-only"
      >
        <input type="checkbox" checked={filter.hideRemoteOnly} onchange={onToggleHideRemoteOnly} />
        <span class="bf-name">Hide remote-only branches</span>
      </label>
      <!-- Select/deselect all (#413). -->
      <label class="bf-row bf-all" title="Select or deselect every branch">
        <input
          type="checkbox"
          checked={allBranchesShown}
          indeterminate={!allBranchesShown && (filter.branchFilter?.length ?? 0) > 0}
          onchange={() => onSetBranchFilter(toggleAllBranchesFilter(filter.branchFilter))}
          data-testid="bf-select-all"
        />
        <span class="bf-name">All branches</span>
      </label>
      {#if authorOptions.length > 0}
        <!-- Author = branch creator: author of the branch's first unique
             commit (tip author for fully-merged branches) (#376).
             Ticking an author (de)selects all branches they created
             (#412); rows share the themed checkbox styling (#411). -->
        <div class="bf-heading">Authors</div>
        {#each authorOptions as author (author)}
          <label class="bf-row bf-author-row" title="Show or hide branches created by {author}">
            <input
              type="checkbox"
              checked={authorShown(authorBranches(author), isBranchShown)}
              onchange={() => onSetBranchFilter(toggleAuthorInFilter(filter.branchFilter, allNames(), authorBranches(author)))}
            />
            <span class="bf-name">{author}</span>
          </label>
        {/each}
        <div class="bf-heading">Branches</div>
      {/if}
      {#each filteredBranchList as b (b.name)}
        <label
          class="bf-row"
          class:bf-bulk-hidden={isHiddenAsRemoteOnly(b.name)}
          title={isHiddenAsRemoteOnly(b.name)
            ? `${b.name} is hidden by "Hide remote-only branches"`
            : `Show or hide ${b.name}`}
        >
          <input
            type="checkbox"
            checked={isBranchShown(b.name)}
            disabled={isHiddenAsRemoteOnly(b.name)}
            onchange={() => onSetBranchFilter(toggleBranchInFilter(filter.branchFilter, allNames(), b.name))}
          />
          <span class="bf-name">{b.name}</span>
          {#if b.remote}<span class="bf-remote">remote</span>{/if}
          <button
            class="bf-only"
            title="Show only {b.name}"
            disabled={isHiddenAsRemoteOnly(b.name)}
            onclick={(e) => {
              e.preventDefault();
              onSetBranchFilter([b.name]);
            }}
          >
            only
          </button>
        </label>
      {:else}
        <div class="bf-empty">No branches</div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* ----- Branch filter (#342) ----- */

  .branch-filter-btn {
    position: absolute;
    left: 6px;
    top: 3px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 20px;
    padding: 0 4px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
    z-index: 3;
  }

  .branch-filter-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .branch-filter-btn.filtered {
    color: var(--accent-text, var(--accent));
  }

  .bf-count {
    font-size: var(--font-size-caption);
    font-weight: 700;
  }

  /* Sits above the .menu-backdrop (z 40) that closes it. */
  .branch-popover {
    position: absolute;
    top: 27px;
    left: 6px;
    z-index: 41;
    width: 240px;
    max-height: 320px;
    display: flex;
    flex-direction: column;
    background: var(--background-solid);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
    font-weight: 400;
  }

  .bf-search,
  .bf-path-search {
    margin: 6px;
    padding: 4px 8px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--background-card);
    color: var(--text-primary);
    font-size: var(--font-size-body);
  }

  .bf-fork-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
  }

  .bf-fork-controls select {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--background-card);
    color: var(--text-primary);
    font: inherit;
  }

  .bf-fork-hint { color: var(--text-secondary); font-size: var(--font-size-caption); }
  .bf-fork-error { color: var(--text-primary); font-size: var(--font-size-caption); }

  /* Section headings inside the filter popover (#412). */
  .bf-heading {
    padding: 6px 6px 2px;
    font-size: var(--font-size-caption);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-tertiary);
  }

  .bf-list {
    overflow-y: auto;
    padding: 0 4px 6px;
  }

  .bf-row,
  /* Bulk option rows (#515) share the row styling but are deliberately not
     `.bf-row` — that class addresses real branches. */
  .bf-opt {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-body);
    color: var(--text-primary);
    cursor: pointer;
  }

  .bf-row:hover,
  .bf-opt:hover {
    background: var(--subtle-fill-secondary);
  }

  /* A branch the bulk toggle is hiding: still listed (so it's clear what the
     toggle covers), but visibly out of play and not individually selectable. */
  .bf-bulk-hidden {
    color: var(--text-tertiary);
    cursor: default;
  }

  .bf-all {
    border-bottom: 1px solid var(--divider);
    border-radius: 0;
  }

  .bf-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bf-remote {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
    border: 1px solid var(--divider);
    border-radius: 3px;
    padding: 0 3px;
  }

  .bf-only {
    visibility: hidden;
    background: none;
    border: none;
    font-size: var(--font-size-caption);
    color: var(--accent-text, var(--accent));
    cursor: pointer;
    padding: 0 2px;
  }

  .bf-row:hover .bf-only {
    visibility: visible;
  }

  .bf-empty {
    padding: 6px 8px;
    color: var(--text-tertiary);
    font-size: var(--font-size-body);
  }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }

  .prompt-btn {
    padding: 5px 12px;
    background: var(--subtle-fill-secondary, transparent);
    border: 1px solid var(--divider);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: var(--font-size-body);
    cursor: pointer;
  }
</style>
