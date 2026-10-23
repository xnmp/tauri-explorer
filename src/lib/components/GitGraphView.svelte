<!--
  GitGraphView — commit-graph pane content for a git-graph tab (#51/#58).
  Renders the repo's history (git_log backend, #57) as a virtualized list of
  rows: an SVG graph cell (lane dot + edge segments from domain/git-graph),
  refs decoration chips, summary, author and date. Pages in more commits as
  the list nears its end.

  This component wires the graph's sessions together and owns the render
  window. Regions render through ./git-graph/ components; actions, filters,
  preferences and the inline expansion live in state/git-graph-*; row
  geometry is pure (domain/git-graph-view).
-->
<script lang="ts">
  import { createGitGraphBranches } from "$lib/state/git-graph-branches.svelte";
  import { createDebouncedReload } from "$lib/state/git-graph-debounced-reload";
  import { createGitPrSession, type PrSnapshot } from "$lib/state/git-pr-session.svelte";
  import type { GraphCommit as CommitInfo } from "$lib/state/git-graph-cache";
  import { createGitGraphQuerySession } from "$lib/state/git-graph-query.svelte";
  import { createGitGraphDetail, UNCOMMITTED_OID } from "$lib/state/git-graph-detail.svelte";
  import { releaseGitSummaryConsumer } from "$lib/state/git-summary-cache";
  import {
    assignLayout,
    detachedHeadIndicator,
    groupRefChips,
    baseUpdateMergeOids,
    shouldMuteBaseUpdateMerge,
    stepOnBranchLine,
    scrollTopToReveal,
    traceGraphLineage,
    type GraphLayout,
    type BranchLineDirection,
    type RefChips,
    type RemoteRefChip,
  } from "$lib/domain/git-graph";
  import {
    formatGraphDate,
    withUncommittedRow,
    GRAPH_LANE_WIDTH as LANE_WIDTH,
    GRAPH_OVERSCAN as OVERSCAN,
    GRAPH_ROW_HEIGHT as ROW_HEIGHT,
    inlineRowExpand,
    minimumGraphTableWidth,
    renderWindow,
    rowY as rowOffset,
    windowGraphGeometry,
    windowTraceSegments,
  } from "$lib/domain/git-graph-view";
  import { branchRef } from "$lib/domain/git-graph-branch-filter";
  import { registerGraphRefresher, subscribeGitNetworkOperation, type GitNetworkOperation } from "$lib/state/git-graph-refresh";
  import { registerGraphSelectionStepper } from "$lib/state/git-graph-nav";
  import { graphPaletteTargets, registerGitPaletteTargets } from "$lib/state/git-palette";
  import { registerGraphFileHistoryHandler } from "$lib/state/git-graph-file-history";
  import { watchGraphRepository } from "$lib/state/git-graph-repo-refresh";
  import { createGitGraphViewPrefs } from "$lib/state/git-graph-view-prefs.svelte";
  import { createGitGraphHistoryFilter } from "$lib/state/git-graph-history-filter.svelte";
  import { createGitGraphActions } from "$lib/state/git-graph-actions.svelte";
  import { createGitGraphPrDialog } from "$lib/state/git-graph-pr-dialog.svelte";
  import { createGitGraphWorkingTree } from "$lib/state/git-graph-working-tree";
  import { createGitGraphExpansion } from "$lib/state/git-graph-expansion.svelte";
  import { useGitGraphMenu } from "$lib/composables/use-git-graph-menu.svelte";
  import { clientToFixed } from "$lib/domain/zoom";
  import { getCommitPanelStore } from "$lib/state/commit-panel.svelte";
  import { onDestroy, untrack, tick } from "svelte";
  import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";
  import { getScmStore } from "$lib/state/scm.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { registerGraphUndoRequester } from "$lib/state/git-graph-undo";
  import { createGitBranchStatusSession } from "$lib/state/git-branch-status.svelte";
  import { branchStatusBadge } from "$lib/domain/git-branch-status";
  import GitGraphBanners from "./git-graph/GitGraphBanners.svelte";
  import GitGraphHeader from "./git-graph/GitGraphHeader.svelte";
  import GitGraphBranchFilter from "./git-graph/GitGraphBranchFilter.svelte";
  import GitGraphColumnMenu from "./git-graph/GitGraphColumnMenu.svelte";
  import GitGraphLanes from "./git-graph/GitGraphLanes.svelte";
  import GitGraphCommitRow from "./git-graph/GitGraphCommitRow.svelte";
  import GitGraphCommitDetail from "./git-graph/GitGraphCommitDetail.svelte";
  import GitGraphPrDetail from "./git-graph/GitGraphPrDetail.svelte";
  import GitGraphCommitMenu from "./git-graph/GitGraphCommitMenu.svelte";
  import GitGraphDialogs from "./git-graph/GitGraphDialogs.svelte";

  const { repoPath }: { repoPath: string } = $props();

  // This pane's SCM store — the preview pane reads the ACTIVE pane's store,
  // and clicking in the graph focuses its pane, so the two line up (#366).
  const paneId = getPaneIdContext();
  const paneKey = () => paneId ?? windowTabsManager.activePaneId ?? "default";
  // The component is keyed on repoPath, so this owner id and the sessions
  // below are intentionally fixed for its lifetime.
  const repo = untrack(() => repoPath);
  const summaryConsumerId = `git-graph:${paneId ?? "default"}:${repo}`;
  onDestroy(() => releaseGitSummaryConsumer(summaryConsumerId));
  const scmStore = $derived(getScmStore(paneKey()));

  const UNCOMMITTED = UNCOMMITTED_OID;

  // Open GitHub PRs keyed by head branch (#448), fetched alongside every
  // graph (re)load and left empty (never surfaced as an error) when GitHub is
  // unavailable; the backend does the degrading.
  const branchSession = createGitGraphBranches(repo);
  onDestroy(() => branchSession.dispose());
  const prSession = createGitPrSession(repo);
  onDestroy(() => prSession.dispose());
  const prsByBranch = $derived(prSession.prsByBranch);
  // Trunk-aware merged / squashed / stale badges (#1081), refreshed with every
  // graph (re)load. Informational only: they never dim rows.
  const branchStatusSession = createGitBranchStatusSession(repo);
  onDestroy(() => branchStatusSession.dispose());
  const detailSession = createGitGraphDetail(repo, summaryConsumerId);
  onDestroy(() => detailSession.dispose());
  const selected = $derived(detailSession.selected);
  let hoveredTraceOid = $state<string | null>(null);
  /** Ephemeral commit-message editor for the uncommitted node (#466). The
   *  state machine lives in `domain/commit-panel`; the live instance lives in
   *  a per-pane rune store so its in-flight commit guard survives the panel
   *  closing and reopening (#444). */
  const commitPanelStore = $derived(getCommitPanelStore(paneKey()));
  const cancelNavigation = () => branchSession.cancelMergeBase();

  // Branch subset (#342), local-only (#381) and remote-only (#515) filters
  // persist per repo; the file-path filter (#529) is ephemeral.
  const filter = createGitGraphHistoryFilter(repo);
  const filePathReload = createDebouncedReload(() => void reload(), 200);
  const prefs = createGitGraphViewPrefs();
  const shownColumns = $derived(prefs.columns);

  // One inline expansion at a time: commit details OR the PR dropdown (#459).
  const expansion = createGitGraphExpansion({
    detail: detailSession,
    pr: prSession,
    commitPanel: () => commitPanelStore,
    cancelNavigation,
  });
  const { closeDetails, closePrDetail, selectCommit } = expansion;
  const prDetail = $derived(prSession.prDetail);
  const prDialog = createGitGraphPrDialog(prSession);

  /** User filter changes retire navigation. Narrowing changes also close both
   *  expansions: the selected commit (or the PR dropdown's anchor row) may
   *  not exist in the new subset. */
  function changeFilter(apply: () => void, narrows = true): void {
    cancelNavigation();
    apply();
    if (!narrows) return;
    closeDetails();
    closePrDetail();
  }
  function onFilePathFilterInput(event: Event): void {
    changeFilter(() => filter.setFilePath((event.target as HTMLInputElement).value));
    filePathReload.schedule();
  }
  const toggleLocalOnly = () => changeFilter(filter.toggleLocalOnly, false);
  const toggleHideRemoteOnly = () => changeFilter(filter.toggleHideRemoteOnly);
  /** null = all branches; [] = none (#413). */
  const setBranchFilter = (next: string[] | null) => changeFilter(() => filter.setBranchFilter(next));

  // This owner starts from the shared page-zero snapshot synchronously. Only
  // a cold view starts a history read; watcher invalidation governs remounts.
  const querySession = createGitGraphQuerySession({
    repoPath: repo,
    summaryConsumerId,
    readQuery: () => untrack(() => ({
      branches: filter.branchFilter,
      localOnly: filter.localOnly,
      hideRemoteOnly: filter.hideRemoteOnly,
      filePath: filter.filePath,
    })),
    readBranches: () => untrack(() => branchSession.branches),
    refreshBranches: branchSession.refreshForQuery,
    onReload: () => {
      void prSession.reloadBadges();
      void branchStatusSession.reload();
    },
    onLoaded: branchSession.invalidate,
  });
  let hasCachedSnapshot = querySession.seeded;
  onDestroy(() => querySession.dispose());

  const commits = $derived(querySession.commits);
  const refs = $derived(querySession.refs);
  const loading = $derived(querySession.loading);
  const headOid = $derived(querySession.headOid);
  const headBranch = $derived(querySession.headBranch);
  // Detached HEAD is an explicit backend mode, not inferred from a missing
  // branch on an unborn repository.
  const detachedIndicator = $derived(detachedHeadIndicator(querySession.detached, headOid));

  // Every watcher, filter and action refresh enters the query owner's shared
  // reloader. Pagination extends the mounted history without replacing its
  // retained page-zero snapshot or adding a separate refresh policy.
  function reload(): Promise<void> {
    filePathReload.cancel();
    cancelNavigation();
    return querySession.reload();
  }

  // Inline commit panel on the uncommitted node (#466) and per-file diffs.
  const workingTree = createGitGraphWorkingTree({
    repoPath: repo,
    detail: detailSession,
    commitPanel: () => commitPanelStore,
    scm: () => scmStore,
    reload,
    closeDetails,
  });

  /** Rows fed to layout/render: the synthetic uncommitted row, then the page. */
  const displayCommits: readonly CommitInfo[] = $derived(withUncommittedRow(commits, {
    oid: UNCOMMITTED,
    workingChanges: querySession.workingChanges,
    headOid,
    filePath: filter.filePath,
    nowMs: Date.now(),
  }));
  const layout: GraphLayout = $derived(assignLayout(displayCommits, headOid));
  const graphWidth = $derived(Math.max(2, layout.laneCount) * LANE_WIDTH);
  const headRow = $derived(displayCommits.findIndex((c) => c.oid === headOid));

  // Column widths (#341): author/date are drag-resizable via header handles
  // (on their left edge → inverted drag) and persisted. The graph gutter is
  // auto (lane-derived) until first dragged, then a fixed width that clips
  // the lane overflow — deep histories can't squeeze the message column out.
  const resizeRegionId = $props.id();
  // The header follows the body's scrollLeft from outside it, so a body scroll
  // (including a clamp as a column narrows) moves the header's handles.
  const headerScrollers = () => [scrollerEl];
  const authorCol = usePersistedPanelWidth("git-graph-col-author", { min: 60, max: 320, default: 120, invert: true },
    { scrollers: headerScrollers });
  const dateCol = usePersistedPanelWidth("git-graph-col-date", { min: 56, max: 220, default: 84, invert: true },
    { scrollers: headerScrollers });
  let graphClip = $state<HTMLElement>();
  const graphCol = usePersistedPanelWidth("git-graph-col-graph", { min: 28, max: 800, default: 56 }, {
    automaticWidth: () => graphWidth,
    element: () => graphClip ?? null,
    scrollers: headerScrollers,
  });
  const effectiveGraphWidth = $derived(graphCol.value);

  // Column visibility (#372) and the other layout preferences are edited
  // through the header's right-click menu.
  let columnMenu = $state<{ x: number; y: number } | null>(null);

  function openColumnMenu(event: MouseEvent): void {
    event.preventDefault();
    columnMenu = { x: clientToFixed(event.clientX), y: clientToFixed(event.clientY) };
  }

  $effect(() => { if (!shownColumns.author) untrack(authorCol.cancel); if (!shownColumns.date) untrack(dateCol.cancel); });

  const baseUpdateMerges = $derived(
    baseUpdateMergeOids(commits, refs, [...prsByBranch.values()]),
  );

  // Branch tracing follows the hovered row, falling back to the persistent
  // selection after the pointer leaves.
  const traceOid = $derived(prefs.branchTracing ? (hoveredTraceOid ?? selected?.oid ?? null) : null);
  const graphTrace = $derived.by(() => {
    if (traceOid === null) return null;
    const row = displayCommits.findIndex((commit) => commit.oid === traceOid);
    return row < 0 ? null : traceGraphLineage(displayCommits, layout, row);
  });

  function onRowHover(commit: CommitInfo, hovered: boolean): void {
    if (hovered) hoveredTraceOid = commit.oid;
    else if (hoveredTraceOid === commit.oid) hoveredTraceOid = null;
  }

  /** Row index of the expanded commit, or -1. */
  const expandedIndex = $derived.by(() => {
    const oid = expansion.expandedOid;
    return oid ? displayCommits.findIndex((c) => c.oid === oid) : -1;
  });
  /** SVG stretch below the inline block (see domain RowExpand). */
  const rowExpand = $derived(inlineRowExpand(expandedIndex, expansion.expandHeight));
  const graphHeight = $derived(displayCommits.length * ROW_HEIGHT + (rowExpand?.extra ?? 0));

  // ── Render windowing (#256) ────────────────────────────────────────────────
  // Only the rows (and SVG geometry) inside the scroll viewport ± overscan
  // are in the DOM; rows are absolutely positioned at their grid offset so
  // scrolling needs no reflow of siblings.
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewportHeight = $state(0);
  let viewportWidth = $state(0);
  // One message cell contains every ref and the subject. Preserve a usable
  // message region and configured metadata widths; narrow panes scroll the
  // table horizontally instead of allowing badges to displace its columns.
  const minimumTableWidth = $derived(minimumGraphTableWidth({
    graph: effectiveGraphWidth,
    author: shownColumns.author ? authorCol.value : null,
    date: shownColumns.date ? dateCol.value : null,
    commit: shownColumns.commit,
    parent: shownColumns.parent,
  }));
  const tableWidth = $derived(Math.max(viewportWidth, minimumTableWidth));
  const headerScrollLeft = $derived(Math.min(scrollLeft, Math.max(0, tableWidth - viewportWidth)));

  /** Pixel offset of a row, accounting for the inline expansion above it. */
  function rowY(index: number): number {
    return rowOffset(index, ROW_HEIGHT, rowExpand);
  }

  /** The scroll viewport, so a jumped-to row can be brought into view — it may
   *  be outside the render window entirely (#530). */
  let scrollerEl = $state<HTMLElement | null>(null);
  $effect(() => {
    // Filtering can replace the viewport. Its new native position owns both
    // the virtual row window and the header offset, never the retired element.
    scrollTop = scrollerEl?.scrollTop ?? 0;
    scrollLeft = scrollerEl?.scrollLeft ?? 0;
  });

  /** Scroll the minimum distance that puts `index` fully in the viewport. */
  function scrollRowIntoView(index: number): void {
    const el = scrollerEl;
    if (!el) return;
    el.scrollTop = scrollTopToReveal(rowY(index), ROW_HEIGHT, el.scrollTop, el.clientHeight);
  }

  /** Select `commit`, then reveal its row once the inline details block has
   *  reflowed the rows below it. Key repeat can land a newer selection while
   *  this one awaits; only the invocation still owning the selection scrolls. */
  async function selectAndReveal(commit: CommitInfo, cancelJump = true): Promise<boolean> {
    await selectCommit(commit, cancelJump);
    await tick();
    if (selected?.oid !== commit.oid) return false;
    scrollRowIntoView(displayCommits.findIndex((c) => c.oid === commit.oid));
    return true;
  }

  /** Move the selection one commit along its branch line (#530). The row math
   *  is the pure `stepOnBranchLine`. No selection means nothing to move — the
   *  shortcut moves the selection, it never creates one. */
  async function stepSelectionOnBranchLine(direction: BranchLineDirection): Promise<void> {
    const current = selected;
    if (!current) return;
    const fromRow = displayCommits.findIndex((c) => c.oid === current.oid);
    const targetRow = stepOnBranchLine(displayCommits, fromRow, direction);
    if (targetRow < 0) return;
    await selectAndReveal(displayCommits[targetRow]);
  }

  /** Select and reveal a fuzzy commit target supplied to the command palette. */
  async function jumpToCommit(oid: string): Promise<void> {
    const index = displayCommits.findIndex((commit) => commit.oid === oid);
    if (index < 0) return;
    await selectCommit(displayCommits[index]);
    await tick();
    if (selected?.oid === oid) scrollRowIntoView(index);
  }

  const visibleWindow = $derived(renderWindow({
    scrollTop,
    viewportHeight,
    rowCount: displayCommits.length,
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
    expand: rowExpand,
  }));
  const visibleRows = $derived(
    displayCommits
      .slice(visibleWindow.startRow, visibleWindow.endRow + 1)
      .map((commit, i) => ({ commit, index: visibleWindow.startRow + i })),
  );
  /** The branch line leaving the synthetic row (drawn gray + dashed up to
   *  the first real commit it reaches). */
  const uncommittedBranch = $derived(
    displayCommits[0]?.oid === UNCOMMITTED
      ? layout.branches.find((b) => b.points[0]?.row === 0)
      : undefined,
  );
  const visibleGeometry = $derived(windowGraphGeometry({
    branches: layout.branches,
    vertices: layout.vertices,
    uncommittedBranch,
    startRow: visibleWindow.startRow,
    endRow: visibleWindow.endRow,
  }));
  const visibleTraceSegments = $derived(
    windowTraceSegments(graphTrace?.segments ?? null, visibleWindow.startRow, visibleWindow.endRow),
  );

  /** Apply a file-history request from the SCM panel. Keeping the filter
   *  ephemeral preserves #529's graph-search behaviour. */
  function showFileHistory(filePath: string): void {
    cancelNavigation();
    filePathReload.cancel();
    closeDetails();
    closePrDetail();
    filter.setFilePath(filePath);
    void reload();
  }

  $effect(() => {
    if (!paneId) return;
    return registerGraphFileHistoryHandler(paneId, showFileHistory);
  });

  // Genuine side effect (IPC) keyed on the repo this tab shows and the
  // active branch filter; reload reads the filter via untrack, so the
  // explicit reads here are the only dependencies.
  $effect(() => {
    void repoPath;
    void filter.branchFilter;
    void filter.localOnly;
    void filter.hideRemoteOnly;
    // PaneContainer remounts the graph whenever a tab becomes active. A
    // snapshot has already supplied the current observable graph, and the
    // watcher invalidates it before a remount when git changes externally, so
    // do not immediately start the same full history walk again.
    if (hasCachedSnapshot) {
      hasCachedSnapshot = false;
      void prSession.reloadBadges();
      void branchStatusSession.reload();
      return;
    }
    // User filter handlers retire navigation themselves. The fork-point
    // action also changes this query, so its own reload must keep ownership.
    untrack(() => void querySession.reload());
  });

  // Live refresh (#365, #432; state/git-graph-repo-refresh). Lookups are
  // retired at observation time, before the trailing reload.
  $effect(() => {
    const stop = watchGraphRepository(repoPath, {
      onObserved: cancelNavigation,
      reload: () => void reload(),
    });
    return () => {
      stop();
      filePathReload.cancel();
    };
  });

  // Mutating actions and the dialogs they drive (state/git-graph-actions).
  const actions = createGitGraphActions({
    repoPath: repo,
    reload,
    cancelNavigation,
    dismissMenu: () => graphMenu.dismiss(),
  });
  const closeMenu = actions.closeMenu;

  // Commit context menu + references disclosure anchor (#405, #1082).
  const graphMenu = useGitGraphMenu({
    scroller: () => scrollerEl,
    localBranchAt: (oid) => (refs[oid] ?? []).find((r) => r.kind === "LocalBranch")?.name ?? null,
    isRowRendered: (oid) => visibleRows.some(({ commit }) => commit.oid === oid),
    commitForShortOid: (shortOid) => displayCommits.find((c) => c.short_oid === shortOid),
    isSynthetic: (commit) => commit.oid === UNCOMMITTED,
    onOpen: () => { actions.prompt = null; },
    close: closeMenu,
  });
  const menu = $derived(graphMenu.menu);

  if (paneId) {
    const unregisterUndoRequester = registerGraphUndoRequester(paneId, actions.requestUndo);
    onDestroy(unregisterUndoRequester);
  }

  // F5 refresh (#432): register this pane's fetch+reload with the command bus
  // so the `gitGraph.refresh` keybinding reaches it — only for the active
  // pane, and visible to the terminal's key-ownership gate (no shadow window
  // listener). Registered per pane id; a remount replaces the prior handler.
  $effect(() => registerGraphRefresher(paneKey(), () => void actions.refreshWithFetch(dropTransientFocus)));

  // Ctrl+Up/Down branch-line jumps (#530): same per-pane bus shape as F5, for
  // the same reason — a window listener here would be unrebindable and would
  // fire for every mounted graph tab, active or not.
  $effect(() => registerGraphSelectionStepper(paneKey(), (dir) => void stepSelectionOnBranchLine(dir)));

  // The palette is window-global but its Git targets belong to this pane.
  // Keep registration in the state-layer bridge so only the active graph pane
  // can expose or execute its branch/commit actions (#520).
  $effect(() => {
    const id = paneKey();
    return registerGitPaletteTargets(id, graphPaletteTargets(refs, commits, {
      checkout: actions.checkoutTarget,
      cherryPick: actions.cherryPick,
      rebase: actions.rebase,
      merge: actions.merge,
      stashApply: actions.stashApply,
      stashPop: actions.stashPop,
      jumpToCommit,
    }));
  });

  // ----- Branch filter popover (#342) -----

  let branchPopoverOpen = $state(false);
  // Branch-filter popover inputs live here (not in the popover) so a
  // load-error recovery that remounts it keeps the search and fork-point picks.
  let branchQuery = $state("");
  let firstMergeBranch = $state("");
  let secondMergeBranch = $state("");

  async function jumpToMergeBase(firstRef: string, secondRef: string): Promise<void> {
    const first = branchSession.branches.find((branch) => branchRef(branch) === firstRef);
    const second = branchSession.branches.find((branch) => branchRef(branch) === secondRef);
    if (!first || !second) return;
    await branchSession.jumpToMergeBase(first, second, async (oid, isCurrent) => {
      // Clear curation so an ancestor cannot be hidden. Walking all refs also
      // avoids local/remote shorthand collisions in the branch-filter API.
      expansion.resetDetails();
      closePrDetail();
      filter.clearAll();
      await tick();
      await querySession.reload();
      if (!isCurrent()) return false;
      const commit = await querySession.findCommit(oid, isCurrent);
      if (!commit || !isCurrent()) return false;
      return selectAndReveal(commit, false);
    }, filePathReload.defer, (revealed) => {
      if (revealed) filePathReload.cancel();
      else filePathReload.releaseDeferred();
    });
    if (branchSession.mergeBaseResult) branchPopoverOpen = false;
  }

  async function toggleBranchPopover(): Promise<void> {
    branchPopoverOpen = !branchPopoverOpen;
    if (branchPopoverOpen) await branchSession.loadForPopover();
  }

  /** Date cells re-render on graph reloads (the watcher makes those frequent),
   *  so relative wording stays fresh enough without a timer (#389). */
  const formatDate = (unixSeconds: number) => formatGraphDate(unixSeconds, Date.now());

  /** Window tracking + near-bottom incremental loading. */
  function handleScroll(event: Event): void {
    const el = event.target as HTMLElement;
    scrollTop = el.scrollTop;
    scrollLeft = el.scrollLeft;
    // Scroll positioning is synchronous, but its notification can follow the
    // disclosure click. Dismiss only movement since the menu acquired its anchor.
    if (graphMenu.anchorMoved({ top: el.scrollTop, left: el.scrollLeft })) closeMenu();
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 20) {
      // loadMore() resumes from the cursor (unfiltered) or the real-commit
      // count (filtered); both are immune to the woven-stash off-by-N (#432).
      if (!loading && querySession.hasMore) void querySession.loadMore();
    }
  }

  /** Combined ref chips — grouping math lives in domain/git-graph.ts. */
  function chipsFor(oid: string): RefChips {
    return groupRefChips(refs[oid] ?? [], headBranch);
  }

  /** Open PR badge for a local-branch chip, if any (#448). */
  function prForHead(name: string): PrSnapshot | undefined {
    return prsByBranch.get(name);
  }

  /** Open PR badge for a remote-only chip, keyed by its branch (not the
   *  full `remote/branch` name) so `origin/feature` still matches a PR
   *  whose head is `feature`. */
  function prForRemote(chip: RemoteRefChip): PrSnapshot | undefined {
    return prsByBranch.get(chip.branch);
  }

  function statusBadgeFor(name: string) {
    return branchStatusBadge(branchStatusSession.statuses.get(name), branchStatusSession.trunk);
  }

  /** Toggle the PR dropdown from a badge inside a clickable commit row, so
   *  the click must not also select the row (#459). */
  function togglePrDetail(event: MouseEvent, commit: CommitInfo, pr: PrSnapshot): void {
    event.stopPropagation();
    expansion.togglePrDetail(commit.oid, pr);
  }

  const isPrDetailOpen = (commit: CommitInfo, pr: PrSnapshot) => expansion.isPrDetailOpen(commit.oid, pr.number);

  /** Blur a commit row / tab that the pointer left focused, so the F5 keypress
   *  doesn't flip it into `:focus-visible` and paint the default white ring
   *  (#433). F5 is an app-wide refresh, not list navigation; focus falls to
   *  <body> and keyboard Tab navigation is unaffected. */
  function dropTransientFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches(".commit-row, .tab")) {
      active.blur();
    }
  }

  let networkOperation = $state<GitNetworkOperation | null>(null);
  $effect(() => subscribeGitNetworkOperation((operation) => (networkOperation = operation)));

  // F5 is handled by the `gitGraph.refresh` command (registered above, gated
  // on the active graph pane) — NOT a raw window listener here (#432). A shadow
  // window binding was invisible to the keybindings registry and the terminal
  // key-ownership gate, and fired for every mounted graph tab, active or not.
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (menu?.trigger) {
      const trigger = menu.trigger;
      closeMenu();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    } else if (branchPopoverOpen) {
      branchPopoverOpen = false;
    } else if (actions.actionModal) {
      actions.actionModal = null;
    } else if (columnMenu) {
      columnMenu = null;
    } else if (prDetail) {
      closePrDetail();
    } else if (menu || actions.prompt) {
      closeMenu();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="git-graph-view" data-testid="git-graph-view" data-lane-count={layout.laneCount}>
  {#if querySession.error}
    <div class="graph-status error">{querySession.error}</div>
  {:else}
    <GitGraphBanners
      {repoPath} {headBranch} {prSession} {detachedIndicator} {networkOperation}
      prDialogOpen={prDialog.dialog !== null}
      onCreatePr={() => void prDialog.openCreate(headBranch)}
    />
    <GitGraphHeader
      {tableWidth} scrollLeft={headerScrollLeft} graphWidth={effectiveGraphWidth}
      regionId={resizeRegionId} {graphCol} {authorCol} {dateCol} columns={shownColumns}
      filePath={filter.filePath.trim()} mergeBase={branchSession.mergeBaseResult}
      onContextMenu={openColumnMenu}
    >
      <GitGraphBranchFilter
        bind:open={branchPopoverOpen} bind:branchQuery
        bind:firstMergeBranch bind:secondMergeBranch {branchSession} {filter}
        onToggle={() => void toggleBranchPopover()}
        onFilePathInput={onFilePathFilterInput}
        onToggleLocalOnly={toggleLocalOnly}
        onToggleHideRemoteOnly={toggleHideRemoteOnly}
        onSetBranchFilter={setBranchFilter}
        onJumpToMergeBase={(first, second) => void jumpToMergeBase(first, second)}
      />
    </GitGraphHeader>
    {#if columnMenu}
      <GitGraphColumnMenu x={columnMenu.x} y={columnMenu.y} {prefs} onClose={() => (columnMenu = null)} />
    {/if}
    {#if commits.length === 0 && loading}
      <div class="graph-status">Loading history…</div>
    {:else if commits.length === 0}
      <div class="graph-status">No commits.</div>
    {:else}
    <div
      class="graph-scroller" onscroll={handleScroll} bind:this={scrollerEl}
      bind:clientHeight={viewportHeight} bind:clientWidth={viewportWidth}
    >
      <div class="graph-body" style:width="{tableWidth}px" style:height="{graphHeight}px">
        <GitGraphLanes
          bind:clipEl={graphClip} clipId={`${resizeRegionId}-graph`} clipWidth={effectiveGraphWidth}
          width={graphWidth} height={graphHeight} rows={displayCommits} {headRow}
          branches={visibleGeometry.branches} {uncommittedBranch}
          traceSegments={visibleTraceSegments} vertices={visibleGeometry.vertices}
          trace={graphTrace} {rowExpand}
        />

        {#each visibleRows as { commit, index } (commit.oid)}
          {@const synthetic = commit.oid === UNCOMMITTED}
          <GitGraphCommitRow
            {commit} chips={chipsFor(commit.oid)} {synthetic}
            selected={selected?.oid === commit.oid}
            muted={prefs.muteMerges && !synthetic && commit.parents.length >= 2}
            baseUpdateMuted={!synthetic && shouldMuteBaseUpdateMerge(commit.oid, baseUpdateMerges, prefs.muteBaseUpdateMerges)}
            leftPadding={effectiveGraphWidth + 20} top={rowY(index)}
            trace={graphTrace ? (graphTrace.rows.has(index) ? "lit" : "dim") : undefined}
            avatars={prefs.avatars} columns={shownColumns}
            authorWidth={authorCol.value} dateWidth={dateCol.value}
            referencesOpen={menu?.kind === "references" && menu.commit.oid === commit.oid}
            {formatDate} {prForHead} {prForRemote} {isPrDetailOpen} statusBadge={statusBadgeFor}
            onSelect={(c) => void selectCommit(c)} onHoverChange={onRowHover}
            onOpenMenu={graphMenu.openMenu} onTogglePr={togglePrDetail}
            onOpenReferences={graphMenu.openReferences}
          />
          {#if selected?.oid === commit.oid}
            <!-- Inline details (VSCode Git Graph parity, #221): expands
                 directly below the clicked row; the graph SVG stretches by
                 its measured height so lower rows stay aligned. The left
                 gutter matches the rows so the block clears the lanes. -->
            <div
              class="commit-detail-inline"
              data-testid="git-graph-detail"
              bind:offsetHeight={expansion.detailsHeight}
              style:margin-left="{effectiveGraphWidth + 12}px"
              style:top="{rowY(index) + ROW_HEIGHT}px"
            >
              <button class="detail-close" onclick={closeDetails} aria-label="Close details">✕</button>
              <GitGraphCommitDetail
                {commit} {synthetic} showMeta={prefs.showDetailMeta} detail={detailSession}
                commitPanel={commitPanelStore} {workingTree} {formatDate}
                onBeginComparison={() => { cancelNavigation(); detailSession.beginComparison(); }}
                onExitComparison={() => { cancelNavigation(); void detailSession.exitComparison(); }}
                onClose={closeDetails}
              />
            </div>
          {/if}
          {#if prDetail?.oid === commit.oid}
            <!-- In-app PR details dropdown (#459): the second inline-expansion
                 source, reusing the same RowExpand stretch. -->
            <div
              class="commit-detail-inline pr-detail-inline"
              data-testid="git-graph-pr-detail"
              bind:offsetHeight={expansion.prDetailHeight}
              style:margin-left="{effectiveGraphWidth + 12}px"
              style:top="{rowY(index) + ROW_HEIGHT}px"
            >
              <button class="detail-close" onclick={closePrDetail} aria-label="Close PR details">✕</button>
              <GitGraphPrDetail pr={prDetail.pr} {prSession} onPrAction={prDialog.openAction} />
            </div>
          {/if}
        {/each}
      </div>
      {#if querySession.loadingMore}
        <!-- Infinite-scroll feedback (#433): a small spinner row appended below
             the (fixed-height) graph body while the next page loads. Flow-laid,
             so it never overlaps the absolutely-positioned commit rows. -->
        <div class="graph-load-more" role="status" data-testid="git-graph-loading-more">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading more…</span>
        </div>
      {/if}
    </div>
    {/if}
  {/if}

  {#if menu}
    <GitGraphCommitMenu
      {menu} bind:menuEl={graphMenu.menuEl} chips={chipsFor(menu.commit.oid)} {actions}
      {prForHead} {prForRemote} onOpenMenu={graphMenu.openMenu} onTogglePr={togglePrDetail}
      onBackdropContextMenu={graphMenu.backdropContextMenu}
    />
  {/if}

  <GitGraphDialogs {repoPath} {actions} {prDialog} {prSession} />
</div>

<style>
  .git-graph-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    /* The measured header must follow the pane, not retain its previous
       width as this flex item's intrinsic minimum during a pane resize. */
    min-width: 0;
    min-height: 0;
    /* No own background: the host .explorer-pane already paints the pane surface
       (content-opacity modulated, transparent under vibrancy). */
    color: var(--text-primary);
  }

  .graph-status {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    font-size: var(--font-size-body);
  }

  .graph-status.error {
    color: var(--system-critical-text, var(--system-critical));
  }

  /* Inline details block, expanded directly below the selected row (#221).
     Margin-left (set inline) clears the graph lanes; opaque card so lanes
     never show through (#227, VSCode layout). */
  .commit-detail-inline {
    position: absolute;
    left: 0;
    right: 0;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    margin-right: 12px;
    margin-bottom: 6px;
    padding: 10px 14px;
    font-size: var(--font-size-body);
    background: var(--background-solid);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  .detail-close {
    position: absolute;
    top: 8px;
    right: 10px;
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: var(--font-size-caption);
  }

  .graph-scroller {
    flex: 1;
    /* Inline-detail height stretches the graph. Reserve the scrollbar space
       so that stretch cannot also narrow/reflow the measured detail during
       the same ResizeObserver delivery. WebKit does not reserve our custom
       scrollbar with scrollbar-gutter: stable alone. */
    overflow-y: scroll;
    min-height: 0;
  }

  .graph-body {
    position: relative;
  }

  /* Infinite-scroll loading row (#433): appended below the graph body while the
     next page loads. Fixed height so appearing/disappearing doesn't jolt the
     scroll position noticeably. */
  .graph-load-more {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 28px;
    font-size: var(--font-size-body);
    color: var(--text-secondary);
  }

  .graph-load-more .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: graph-spin 600ms linear infinite;
    flex-shrink: 0;
  }

  @keyframes graph-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
