<!--
  GitGraphView — commit-graph pane content for a git-graph tab (#51/#58).
  Renders the repo's history (git_log backend, #57) as a virtualized list of
  rows: an SVG graph cell (lane dot + edge segments from domain/git-graph),
  refs decoration chips, summary, author and date. Pages in more commits as
  the list nears its end.
-->
<script lang="ts" module>
  import { gitCommitFiles as gitCommitFilesApi, type CommitFile as ApiCommitFile } from "$lib/api/git-log";
  // Snapshot cache lives in the state layer now (#433 / arch Finding 7) so the
  // git warmer no longer imports from this component.
  import {
    PAGE_SIZE,
    snapshotKey,
    getSnapshot,
    cacheSnapshot,
    fetchPage0Snapshot,
  } from "$lib/state/git-graph-cache";

  /**
   * Per-commit changed-file lists (#431). A commit's file list is immutable
   * (fixed by its OID), so re-clicking a commit — or reopening one after
   * scrolling away — should never re-invoke the backend diff. Bounded LRU keyed
   * by repo+OID; the uncommitted row is served from the shared summary cache
   * instead (its contents change) and never enters here.
   */
  const commitFilesCache = new Map<string, ApiCommitFile[]>();
  const COMMIT_FILES_MAX = 50;

  async function cachedCommitFiles(repoPath: string, oid: string): Promise<ApiCommitFile[]> {
    const key = `${repoPath}\0${oid}`;
    const hit = commitFilesCache.get(key);
    if (hit) {
      commitFilesCache.delete(key); // refresh LRU position
      commitFilesCache.set(key, hit);
      return hit;
    }
    const files = await gitCommitFilesApi(repoPath, oid);
    commitFilesCache.set(key, files);
    if (commitFilesCache.size > COMMIT_FILES_MAX) {
      const oldest = commitFilesCache.keys().next().value;
      if (oldest !== undefined) commitFilesCache.delete(oldest);
    }
    return files;
  }
</script>

<script lang="ts">
  import {
    gitCommitFileDiff,
    gitCheckout,
    gitCreateBranch,
    gitCreateTag,
    gitCherryPick,
    gitRevert,
    gitMerge,
    gitRebase,
    gitReset,
    gitRefs,
    gitFetch,
    gitPull,
    gitBranchBehindUpstream,
    gitBranchAuthors,
    gitDeleteBranch,
    gitDeleteRemoteBranch,
    gitCheckoutTracking,
    gitSyncLocalBranches,
    gitLog,
    gitOpenPrs,
    type CommitInfo,
    type RefInfo,
    type CommitFile,
    type ResetMode,
    type OpenPr,
  } from "$lib/api/git-log";
  import {
    fetchGitSummary,
    releaseGitSummaryConsumer,
  } from "$lib/state/git-summary-cache";
  import { assignLayout, branchPath, detachedHeadIndicator, groupRefChips, indexPrsByBranch, prBadgePresentation, ciStatusLabel, reviewDecisionLabel, prDescription, prDetailComments, sliceBranchLine, stepOnBranchLine, scrollTopToReveal, remoteOnlyBranchNames, branchWalkQuery, GRAPH_PALETTE, type GraphLayout, type BranchLine, type BranchLineDirection, type RefChips, type RemoteRefChip, type BranchListEntry } from "$lib/domain/git-graph";
  import { openExternalUrl } from "$lib/api/crash";
  import {
    countGraphWalkCommits,
    createReloader,
    registerGraphRefresher,
    shouldReloadGraphForChange,
  } from "$lib/state/git-graph-refresh";
  import { registerGraphSelectionStepper } from "$lib/state/git-graph-nav";
  import { registerGraphFileHistoryHandler } from "$lib/state/git-graph-file-history";
  import { clientToFixed } from "$lib/domain/zoom";
  import { parseUnifiedDiff, type ParsedDiff } from "$lib/domain/diff";
  import { highlightDiffLine } from "$lib/domain/syntax-highlight";
  import { compactRelativeTimeToday } from "$lib/domain/git";
  import { notifyLocalGitChange, subscribeGitChanges } from "$lib/state/git-refresh";
  import { gitWatchRepo, gitUnwatchRepo } from "$lib/api/git";
  import { directoryKey, splitPathForDisplay } from "$lib/domain/path";
  import { toastStore } from "$lib/state/toast.svelte";
  import { gitDiff, gitStage, gitUnstage, gitCommit } from "$lib/api/files";
  import {
    buildStageFiles,
    groupStageFiles,
    stagedCountOf,
    conflictCountOf,
    canCommit,
    commitButtonLabel,
    type StageSection,
    type StageFile,
  } from "$lib/domain/commit-panel";
  import { getCommitPanelStore } from "$lib/state/commit-panel.svelte";
  import { onDestroy, untrack, tick } from "svelte";
  import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";
  import { loadPersisted, savePersisted } from "$lib/state/persisted";
  import { getScmStore } from "$lib/state/scm.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";

  const { repoPath }: { repoPath: string } = $props();

  // This pane's SCM store — the preview pane reads the ACTIVE pane's store,
  // and clicking in the graph focuses its pane, so the two line up (#366).
  const paneId = getPaneIdContext();
  // The component is keyed on repoPath, so this owner id is intentionally
  // fixed for its lifetime.
  const summaryConsumerId = `git-graph:${paneId ?? "default"}:${untrack(() => repoPath)}`;
  onDestroy(() => releaseGitSummaryConsumer(summaryConsumerId));
  const scmStore = $derived(getScmStore(paneId ?? windowTabsManager.activePaneId ?? "default"));

  const ROW_HEIGHT = 28;
  const LANE_WIDTH = 14;
  // PAGE_SIZE lives in the module script (shared with warmGraphSnapshot).
  const UNCOMMITTED = "*";

  let commits = $state<CommitInfo[]>([]);
  let refs = $state<Record<string, RefInfo[]>>({});
  // Open GitHub PRs keyed by head branch (#448). Fetched alongside every
  // graph (re)load — piggybacking the existing refresh machine rather than
  // adding a private timer — and left empty (never surfaced as an error) for
  // repos without a GitHub remote, offline machines, or rate-limit failures;
  // the backend does the degrading.
  let prsByBranch = $state<Map<string, OpenPr>>(new Map());
  let hasMore = $state(false);
  // Resume cursor for the next page (#431). Points at the last real commit
  // loaded; passed to `gitLog` so deeper pages resume instead of skip-walking.
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  // Distinct from `loading` (initial/full reload → "Loading history…"): true
  // only while a scroll-triggered page append is in flight, so a small spinner
  // row shows at the list bottom during infinite scroll (#433).
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let selected = $state<CommitInfo | null>(null);
  /** File rows in the expanded details. `staged`/`section` are set only for
   *  the synthetic uncommitted row, where they pick the right working-tree
   *  diff and drive the stage/unstage affordances (#466). */
  interface DetailFile extends CommitFile {
    staged?: boolean;
    section?: StageSection;
  }
  let selectedFiles = $state<DetailFile[]>([]);
  /** Ephemeral commit-message editor for the uncommitted node (#466). The
   *  state machine (transitions) lives in `domain/commit-panel`; the live
   *  instance lives in a per-pane rune store so its in-flight commit guard
   *  survives the panel closing and reopening (a second concurrent commit must
   *  not be startable via Escape + reopen), and stays unit-testable (#444). */
  const commitPanelStore = $derived(
    getCommitPanelStore(paneId ?? windowTabsManager.activePaneId ?? "default"),
  );
  /** Working-tree change count → synthetic top row (reference behavior). */
  let workingChanges = $state(0);
  let headOid = $state<string | null>(null);
  // Checked-out branch (HEAD's symbolic target); highlights only that chip (#433).
  let headBranch = $state<string | null>(null);
  // Detached HEAD (#524): a MODE, not an event — surfaced as a standing badge
  // for as long as it lasts, so it survives the checkout menu closing. Read
  // from the log payload, never inferred from `headBranch === null` (also null
  // on an unborn branch).
  let detached = $state(false);
  // Graph-wide commit filter (#529). Kept ephemeral: unlike branch curation,
  // a one-off path lookup should not silently survive reopening the graph.
  let filePathFilter = $state("");
  let filePathReloadTimer: ReturnType<typeof setTimeout> | null = null;

  function onFilePathFilterInput(event: Event): void {
    filePathFilter = (event.target as HTMLInputElement).value;
    closeDetails();
    closePrDetail();
    if (filePathReloadTimer !== null) clearTimeout(filePathReloadTimer);
    filePathReloadTimer = setTimeout(() => {
      filePathReloadTimer = null;
      void reload();
    }, 200);
  }

  const detachedIndicator = $derived(detachedHeadIndicator(detached, headOid));

  // Branch subset filter (#342): null = all branches. Persisted per repo so a
  // curated view (e.g. just dev + main) survives reopening the graph.
  const BRANCH_FILTER_KEY = `git-graph-branch-filter:${untrack(() => repoPath)}`;
  const savedBranchFilter = loadPersisted<unknown>(BRANCH_FILTER_KEY, null);
  // An empty array is a valid persisted state: "no branches selected" (#413).
  let branchFilter = $state<string[] | null>(
    Array.isArray(savedBranchFilter) && savedBranchFilter.every((s) => typeof s === "string")
      ? (savedBranchFilter as string[])
      : null,
  );

  // Local-branches-only (#381): hide history reachable solely from
  // remote-tracking branches. Persisted per repo, like the branch filter.
  const LOCAL_ONLY_KEY = `git-graph-local-only:${untrack(() => repoPath)}`;
  let localOnly = $state(loadPersisted<unknown>(LOCAL_ONLY_KEY, false) === true);

  function toggleLocalOnly(): void {
    localOnly = !localOnly;
    savePersisted(LOCAL_ONLY_KEY, localOnly);
  }

  // Bulk hide of remote-only branches (#515): drop every remote ref that no
  // local branch tracks (`origin/legacy-import` with no local `legacy-import`)
  // from the walked set in one action. A separate axis from the per-branch /
  // author selection — like `localOnly` — so toggling it never destroys a
  // curated selection. Persisted per repo.
  const HIDE_REMOTE_ONLY_KEY = `git-graph-hide-remote-only:${untrack(() => repoPath)}`;
  let hideRemoteOnly = $state(loadPersisted<unknown>(HIDE_REMOTE_ONLY_KEY, false) === true);

  function toggleHideRemoteOnly(): void {
    hideRemoteOnly = !hideRemoteOnly;
    savePersisted(HIDE_REMOTE_ONLY_KEY, hideRemoteOnly);
    // The selected commit may not exist in the new subset (mirrors
    // setBranchFilter).
    closeDetails();
    closePrDetail();
  }

  // Paint the last-known graph immediately on remount (#255); the load
  // effect below still refreshes from git in the background. The cache is
  // keyed by repo + filter + local-only (#416), so a filtered remount paints
  // its own filtered snapshot — never another filter's rows (#342, #381).
  {
    // untrack: the view is {#key}ed on repoPath, so the initial values are
    // the right ones for this instance's lifetime.
    const cached = getSnapshot(
      untrack(() => snapshotKey(repoPath, branchFilter, localOnly, hideRemoteOnly)),
    );
    if (cached) {
      commits = cached.commits;
      refs = cached.refs;
      hasMore = cached.hasMore;
      headOid = cached.headOid;
      headBranch = cached.headBranch;
      detached = cached.detached === true;
      workingChanges = cached.workingChanges;
      nextCursor = cached.nextCursor;
    }
  }

  // Inline per-file diff (#221, VSCode Git Graph parity): one open at a time.
  let openDiffPath = $state<string | null>(null);
  let openDiff = $state<ParsedDiff | null>(null);
  let diffLoading = $state(false);
  // Measured height of the inline details block; stretches the graph SVG so
  // rows below the expansion stay aligned with their vertices.
  let detailsHeight = $state(0);

  // In-app PR details dropdown (#459): the second inline-expansion source
  // alongside commit details. Anchored to a commit row's oid so it reuses the
  // same RowExpand stretch. Only one expansion (commit OR PR) is open at a
  // time, which keeps the RowExpand derivation single-valued.
  let prDetail = $state<{ oid: string; pr: OpenPr } | null>(null);
  let prDetailHeight = $state(0);

  function closePrDetail(): void {
    prDetail = null;
    prDetailHeight = 0;
  }

  function closeDetails(): void {
    selected = null;
    selectedFiles = [];
    // Ephemeral editor: a fresh open starts blank (mirrors keifu's
    // commit_editor) — but NOT while a commit is in flight, so close+reopen
    // can't drop the in-flight guard and let a second commit start (#466).
    commitPanelStore.resetIfIdle();
    openDiffPath = null;
    openDiff = null;
    detailsHeight = 0;
  }

  async function selectCommit(commit: CommitInfo): Promise<void> {
    // Opening commit details closes any open PR dropdown — one expansion at a
    // time (#459).
    closePrDetail();
    if (selected?.oid === commit.oid) {
      closeDetails();
      return;
    }
    closeDetails();
    selected = commit;
    try {
      if (commit.oid === UNCOMMITTED) {
        // Working-tree changes: group the SCM summary buckets by stage status
        // (merge / staged / unstaged / untracked), remembering which side of
        // the index each file sits on for the diff and the stage/unstage
        // affordance (#466). Served from the shared summary cache (#431) — the
        // graph's own reload just scanned this, so selecting the row reuses it
        // instead of re-scanning.
        const res = await fetchGitSummary(repoPath, { consumerId: summaryConsumerId });
        if (!res.ok) throw new Error(res.error);
        selectedFiles = buildStageFiles(res.data);
      } else {
        // Cached per OID (#431): re-clicking or re-selecting a commit is instant.
        selectedFiles = await cachedCommitFiles(repoPath, commit.oid);
      }
    } catch {
      selectedFiles = [];
    }
  }

  /** Expand/collapse one file's diff below its row. */
  async function toggleFileDiff(file: DetailFile): Promise<void> {
    const forPreview = selected;
    // Preview pane open (#366): route the diff there instead of inline.
    if (settingsStore.showPreviewPane && forPreview) {
      if (forPreview.oid === UNCOMMITTED) {
        // Working-tree diffs go through the SCM store's own loader, which
        // needs its repoRoot on THIS repo; otherwise keep the inline diff.
        if (scmStore.repoRoot && directoryKey(scmStore.repoRoot) === directoryKey(repoPath)) {
          openDiffPath = null;
          openDiff = null;
          scmStore.openDiff(file.path, !!file.staged);
          return;
        }
      } else {
        openDiffPath = null;
        openDiff = null;
        scmStore.openCommitDiff(repoPath, forPreview.oid, file.path);
        return;
      }
    }
    if (openDiffPath === file.path) {
      openDiffPath = null;
      openDiff = null;
      return;
    }
    const forCommit = selected;
    if (!forCommit) return;
    openDiffPath = file.path;
    openDiff = null;
    diffLoading = true;
    try {
      const text =
        forCommit.oid === UNCOMMITTED
          ? await gitDiff(repoPath, file.path, { staged: !!file.staged }).then((r) => {
              if (!r.ok) throw new Error(r.error);
              return r.data;
            })
          : await gitCommitFileDiff(repoPath, forCommit.oid, file.path);
      // Ignore a late response if the user moved on.
      if (openDiffPath === file.path && selected?.oid === forCommit.oid) {
        openDiff = parseUnifiedDiff(text);
      }
    } catch (err) {
      if (openDiffPath === file.path) {
        toastStore.error(err instanceof Error ? err.message : String(err));
        openDiffPath = null;
      }
    } finally {
      diffLoading = false;
    }
  }

  // ── Inline commit panel on the uncommitted node (#466) ─────────────────────
  // Grouped file sections + commit-button enablement are pure derivations
  // (domain/commit-panel). Stage/unstage/commit orchestrate the existing
  // backend commands and route refresh through the standard policy — reload()
  // for the graph, notifyLocalGitChange() for badges + an open SCM panel — so
  // no private refresh stack lives here (the cause of #431/#432).
  const stageGroups = $derived(groupStageFiles(selectedFiles as StageFile[]));
  const uncommittedStagedCount = $derived(stagedCountOf(selectedFiles as StageFile[]));
  const uncommittedConflictCount = $derived(conflictCountOf(selectedFiles as StageFile[]));
  const commitEnabled = $derived(
    canCommit({
      message: commitPanelStore.message,
      stagedCount: uncommittedStagedCount,
      conflictCount: uncommittedConflictCount,
    }),
  );

  /** Re-scan the working tree and rebuild the grouped file list in place
   *  (after a stage/unstage/commit). Forces past the summary-cache TTL so the
   *  post-mutation state is observed. */
  async function refreshUncommittedFiles(): Promise<void> {
    const res = await fetchGitSummary(repoPath, {
      force: true,
      consumerId: summaryConsumerId,
    });
    selectedFiles = res.ok ? buildStageFiles(res.data) : [];
  }

  /** After a stage/unstage: rebuild the panel's file list, then reload() so
   *  the synthetic row's "Uncommitted Changes (N)" count is recomputed from
   *  the canonical summary. A partially-staged file is double-counted in that
   *  total (it sits in both `staged` and `changes`), so staging/unstaging it
   *  flips the count by one — without this reload the header would go stale
   *  until a watcher event (#466). Routes through the same refresh channels as
   *  every other graph action; no private refresh machinery. */
  async function afterStageChange(): Promise<void> {
    await refreshUncommittedFiles();
    await reload();
    notifyLocalGitChange(repoPath);
  }

  async function stagePaths(paths: string[]): Promise<void> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return;
    const r = await gitStage(repoPath, unique);
    if (!r.ok) {
      toastStore.error(r.error);
      return;
    }
    await afterStageChange();
  }

  async function unstagePaths(paths: string[]): Promise<void> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return;
    const r = await gitUnstage(repoPath, unique);
    if (!r.ok) {
      toastStore.error(r.error);
      return;
    }
    await afterStageChange();
  }

  async function commitUncommitted(): Promise<void> {
    if (!commitEnabled) return;
    const message = commitPanelStore.message;
    // Atomic in-flight guard: begin() returns false if a commit is already
    // running for this pane, so Escape + reopen mid-flight can't start a second
    // concurrent gitCommit (which, absent the backend guard, could be empty).
    if (!commitPanelStore.begin()) return;
    const r = await gitCommit(repoPath, message);
    if (!r.ok) {
      // Preserve the typed message so the user can fix and retry (#466).
      commitPanelStore.fail(r.error);
      toastStore.error(r.error);
      return;
    }
    commitPanelStore.succeed();
    toastStore.success("Changes committed");
    // Standard refresh policy: reload the graph (new commit row + refreshed
    // working-changes count), rebuild the still-open panel's file list, and
    // announce the change so badges + an open SCM panel update (#102, #432).
    await reload();
    await refreshUncommittedFiles();
    notifyLocalGitChange(repoPath);
    if (scmStore.repoRoot && directoryKey(scmStore.repoRoot) === directoryKey(repoPath)) {
      void scmStore.refresh();
    }
    // Working tree now clean → the synthetic row is gone; close the stale panel.
    if (selectedFiles.length === 0) closeDetails();
  }

  function onCommitBoxKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDetails();
      return;
    }
    // Ctrl/Cmd+Enter commits; plain Enter inserts a newline (multiline message).
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void commitUncommitted();
    }
  }

  /** Rows fed to layout/render: a synthetic uncommitted-changes row on top
   *  (when the working tree is dirty and HEAD is loaded), then the page. */
  const displayCommits: CommitInfo[] = $derived(
    workingChanges > 0 && headOid && !filePathFilter.trim()
      ? [
          {
            oid: UNCOMMITTED,
            short_oid: UNCOMMITTED,
            parents: [headOid],
            author_name: "*",
            author_email: "",
            author_time: Math.floor(Date.now() / 1000),
            summary: `Uncommitted Changes (${workingChanges})`,
          },
          ...commits,
        ]
      : commits,
  );
  const layout: GraphLayout = $derived(assignLayout(displayCommits, headOid));
  const graphWidth = $derived(Math.max(2, layout.laneCount) * LANE_WIDTH);

  // Column widths (#341): author/date are drag-resizable via header handles
  // (on their left edge → inverted drag) and persisted. The graph gutter is
  // auto (lane-derived) until first dragged, then a fixed width that clips
  // the lane overflow — deep histories can't squeeze the message column out.
  const authorCol = usePersistedPanelWidth("git-graph-col-author", { min: 60, max: 320, default: 120, invert: true });
  const dateCol = usePersistedPanelWidth("git-graph-col-date", { min: 56, max: 220, default: 84, invert: true });
  const GRAPH_COL_KEY = "git-graph-col-graph";
  const GRAPH_COL_MIN = 28;
  const GRAPH_COL_MAX = 800;
  const savedGraphCol = loadPersisted<unknown>(GRAPH_COL_KEY, null);
  let graphCol = $state<number | null>(
    typeof savedGraphCol === "number" && Number.isFinite(savedGraphCol) ? savedGraphCol : null,
  );
  let graphColResizing = $state(false);
  const effectiveGraphWidth = $derived(
    graphCol === null ? graphWidth : Math.max(GRAPH_COL_MIN, Math.min(GRAPH_COL_MAX, graphCol)),
  );

  // Column visibility (#372): author/date/commit are hideable via the
  // header's right-click menu; message and the graph itself always show.
  // Persisted globally (a layout preference, not per-repo).
  const COLUMNS_KEY = "git-graph-columns";
  type ColumnId = "author" | "date" | "commit" | "parent";
  const savedColumns = loadPersisted<unknown>(COLUMNS_KEY, null);
  let shownColumns = $state<Record<ColumnId, boolean>>({
    author: true,
    date: true,
    commit: true,
    // Parent OIDs are niche — a viewable column, off by default (#402).
    parent: false,
    ...(typeof savedColumns === "object" && savedColumns !== null ? savedColumns : {}),
  });
  let columnMenu = $state<{ x: number; y: number } | null>(null);

  function toggleColumn(id: ColumnId): void {
    shownColumns = { ...shownColumns, [id]: !shownColumns[id] };
    savePersisted(COLUMNS_KEY, shownColumns);
  }

  // Commit-detail metadata (hash/parents/author/date) is hidden by default
  // (#402) — the graph columns already carry it; the detail block leads with
  // the message and files. Toggle lives in the header context menu.
  const DETAIL_META_KEY = "git-graph-detail-meta";
  let showDetailMeta = $state(loadPersisted<unknown>(DETAIL_META_KEY, false) === true);
  function toggleDetailMeta(): void {
    showDetailMeta = !showDetailMeta;
    savePersisted(DETAIL_META_KEY, showDetailMeta);
  }

  // Merge commits (parents.length >= 2) are usually noise when skimming
  // history, so their row text is dimmed by default (#458). Toggle lives in
  // the header context menu; persisted like the other layout preferences.
  const MUTE_MERGES_KEY = "git-graph-mute-merges";
  let muteMerges = $state(loadPersisted<unknown>(MUTE_MERGES_KEY, true) !== false);
  function toggleMuteMerges(): void {
    muteMerges = !muteMerges;
    savePersisted(MUTE_MERGES_KEY, muteMerges);
  }

  function openColumnMenu(event: MouseEvent): void {
    event.preventDefault();
    columnMenu = { x: clientToFixed(event.clientX), y: clientToFixed(event.clientY) };
  }

  function startGraphColResize(event: MouseEvent): void {
    event.preventDefault();
    graphColResizing = true;
    const startX = event.clientX;
    const startWidth = effectiveGraphWidth;
    function onMouseMove(e: MouseEvent) {
      graphCol = Math.max(GRAPH_COL_MIN, Math.min(GRAPH_COL_MAX, startWidth + (e.clientX - startX)));
    }
    function onMouseUp() {
      graphColResizing = false;
      savePersisted(GRAPH_COL_KEY, graphCol);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }
  /** Oid of the row with an open inline expansion — commit details OR the PR
   *  dropdown (#459). Only one is ever open (each opener closes the other), so
   *  this stays single-valued and the RowExpand math is unchanged. */
  const expandedOid = $derived(selected?.oid ?? prDetail?.oid ?? null);
  /** Row index of the expanded commit, or -1. */
  const expandedIndex = $derived(
    expandedOid ? displayCommits.findIndex((c) => c.oid === expandedOid) : -1,
  );
  /** Height of whichever inline block is open (commit details or PR dropdown). */
  const expandHeight = $derived(selected ? detailsHeight : prDetail ? prDetailHeight : 0);
  /** SVG stretch below the inline block (see domain RowExpand). */
  const rowExpand = $derived(
    expandedIndex >= 0 && expandHeight > 0
      ? // +6: the block's bottom gap (its margin-bottom is outside offsetHeight).
        { afterRow: expandedIndex, extra: expandHeight + 6 }
      : undefined,
  );
  const graphHeight = $derived(
    displayCommits.length * ROW_HEIGHT + (rowExpand?.extra ?? 0),
  );

  // ── Render windowing (#256) ────────────────────────────────────────────────
  // Only the rows (and SVG geometry) inside the scroll viewport ± overscan
  // are in the DOM; rows are absolutely positioned at their grid offset so
  // scrolling needs no reflow of siblings.
  const OVERSCAN = 12;
  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  /** Row index at a given scroll offset, accounting for the inline expansion. */
  function rowAtY(y: number): number {
    if (rowExpand) {
      const expandTop = (rowExpand.afterRow + 1) * ROW_HEIGHT;
      if (y >= expandTop) y = Math.max(expandTop, y - rowExpand.extra);
    }
    return Math.floor(y / ROW_HEIGHT);
  }

  /** Pixel offset of a row, accounting for the inline expansion above it. */
  function rowY(index: number): number {
    return index * ROW_HEIGHT + (rowExpand && index > rowExpand.afterRow ? rowExpand.extra : 0);
  }

  /** The scroll viewport, so a jumped-to row can be brought into view — it may
   *  be outside the render window entirely (#530). */
  let scrollerEl = $state<HTMLElement | null>(null);

  /** Scroll the minimum distance that puts `index` fully in the viewport. */
  function scrollRowIntoView(index: number): void {
    const el = scrollerEl;
    if (!el) return;
    el.scrollTop = scrollTopToReveal(rowY(index), ROW_HEIGHT, el.scrollTop, el.clientHeight);
  }

  /** Move the selection one commit along its branch line (#530). The row math
   *  is the pure `stepOnBranchLine`; this only maps rows back onto the
   *  selection. No selection means nothing to move — the shortcut moves the
   *  selection, it never creates one. */
  async function stepSelectionOnBranchLine(direction: BranchLineDirection): Promise<void> {
    const current = selected;
    if (!current) return;
    const fromRow = displayCommits.findIndex((c) => c.oid === current.oid);
    const targetRow = stepOnBranchLine(displayCommits, fromRow, direction);
    if (targetRow < 0) return;
    const target = displayCommits[targetRow];
    await selectCommit(target);
    // The inline details block reflows the rows below it, so wait for the
    // derived offsets to settle before measuring where the target landed.
    await tick();
    // Key repeat can land a newer jump while this one is still awaiting; only
    // the invocation that still owns the selection gets to scroll.
    if (selected?.oid !== target.oid) return;
    scrollRowIntoView(displayCommits.findIndex((c) => c.oid === target.oid));
  }

  const startRow = $derived(Math.max(0, rowAtY(scrollTop) - OVERSCAN));
  const endRow = $derived(
    Math.min(displayCommits.length - 1, rowAtY(scrollTop + viewportHeight) + OVERSCAN),
  );
  const visibleRows = $derived(
    displayCommits.slice(startRow, endRow + 1).map((commit, i) => ({ commit, index: startRow + i })),
  );
  /** Branch lines clipped to the window (full line kept for the dashed
   *  uncommitted branch — it's split at HEAD by object identity below). */
  const visibleBranches = $derived(
    layout.branches
      .map((line) =>
        line === uncommittedBranch ? line : sliceBranchLine(line, startRow - 2, endRow + 2),
      )
      .filter((line): line is BranchLine => line !== null),
  );
  const visibleVertices = $derived(
    layout.vertices
      .slice(startRow, endRow + 1)
      .map((vertex, i) => ({ vertex, vi: startRow + i })),
  );

  /** The branch line leaving the synthetic row (drawn gray + dashed up to
   *  the first real commit it reaches). */
  const uncommittedBranch = $derived(
    displayCommits[0]?.oid === UNCOMMITTED
      ? layout.branches.find((b) => b.points[0]?.row === 0)
      : undefined,
  );

  // ── Unified refresh (#432) ─────────────────────────────────────────────────
  // The graph has ONE reload entry point. Previously three uncoordinated
  // triggers (repo/filter effect, watcher subscription, and each mutating
  // action's own loadPage) raced, and a watcher refresh arriving mid-load was
  // silently dropped — the structural cause of "pull completes but the graph
  // doesn't update". Now a generation counter discards stale results and a
  // dirty flag re-runs a request that arrived while a load was in flight, so a
  // refresh is never lost. The state-layer reloader owns the generation and
  // dirty-flag machine so its concurrency contract is directly testable.

  /** PR badges (#448): fetched alongside every reload, never blocking the
   *  commit-list paint. `repo` is captured by the caller so a repoPath
   *  change mid-flight can't clobber a newer repo's badges with a stale
   *  response. Errors never surface here — `gitOpenPrs` itself resolves to
   *  `[]` for every offline/no-remote/rate-limit condition. */
  async function loadPrs(repo: string): Promise<void> {
    try {
      const prs = await gitOpenPrs(repo);
      if (repo === repoPath) prsByBranch = indexPrsByBranch(prs);
    } catch {
      if (repo === repoPath) prsByBranch = new Map();
    }
  }

  const reloader = createReloader(async ({ isCurrent }) => {
    // Captured once so a mid-flight filter change can't mix pages. Every
    // page-0 load is cached under its own repo+filter key (#416), so
    // re-entering the same view — filtered or not — paints instantly.
    const selection = untrack(() => branchFilter);
    const local = untrack(() => localOnly);
    const hideRemotes = untrack(() => hideRemoteOnly);
    const filePath = untrack(() => filePathFilter.trim());
    // Cache under the RAW selection + toggles: the excluded set below depends
    // on the lazily-loaded branch list, so keying on it would let a pre-load
    // remount paint the unfiltered variant's rows (#416).
    const cacheKey = snapshotKey(repoPath, selection, local, hideRemotes, filePath);
    loading = true;
    error = null;
    void loadPrs(repoPath);
    // Which refs are remote-only is only knowable from the branch list, which
    // the popover loads lazily — refresh it here so a persisted toggle applies
    // on the first paint too, and stays right after refs move (#515).
    if (hideRemotes) await loadBranchList();
    const { branches: filter, excludeBranches } = branchWalkQuery(
      untrack(() => branchList),
      selection,
      hideRemotes,
    );
    try {
      // Same page-0 fetch used by the background warm (#287). The commit list
      // paints as soon as the log arrives; the working-changes count (a full
      // status scan, slow on big working trees) fills in after (#367). Every
      // write is guarded on `gen` so a stale in-flight load can't clobber a
      // newer one's results.
      const snapshot = await fetchPage0Snapshot(repoPath, filter, (partial) => {
        if (!isCurrent()) return;
        commits = partial.commits;
        refs = partial.refs;
        hasMore = partial.hasMore;
        headOid = partial.headOid;
        headBranch = partial.headBranch;
        detached = partial.detached === true;
        nextCursor = partial.nextCursor;
        loading = false;
      }, local, excludeBranches, filePath, summaryConsumerId);
      if (!isCurrent()) return;
      workingChanges = snapshot.workingChanges;
      cacheSnapshot(cacheKey, snapshot);
      // Branch list / author map may be stale after a reload (refs moved on a
      // pull, F5 fetch, or local action). Invalidate so the next popover open
      // refetches lazily (#431); keep the current values visible until then.
      branchDataLoaded = false;
    } catch (err) {
      if (isCurrent()) error = err instanceof Error ? err.message : String(err);
    } finally {
      if (isCurrent()) loading = false;
    }
  });

  const reload = reloader.reload;

  /** Apply a file-history request from the SCM panel. Keeping the filter
   *  component-local preserves #529's ephemeral graph-search behaviour. */
  function showFileHistory(filePath: string): void {
    if (filePathReloadTimer !== null) {
      clearTimeout(filePathReloadTimer);
      filePathReloadTimer = null;
    }
    closeDetails();
    closePrDetail();
    filePathFilter = filePath;
    void reload();
  }

  $effect(() => {
    if (!paneId) return;
    return registerGraphFileHistoryHandler(paneId, showFileHistory);
  });

  /** Append the next page of history (incremental scroll). Distinct from
   *  `reload()`: it never resets the head of the list, so it doesn't race the
   *  unified refresh. */
  /** Cursor that resumes AFTER a cached slice: its last real (non-stash)
   *  commit. Keeps the cached snapshot's cursor consistent with its rows so a
   *  remount resumes gap-free (#431). */
  function cursorForSlice(slice: CommitInfo[]): string | null {
    for (let i = slice.length - 1; i >= 0; i--) {
      if (!slice[i].stash) return slice[i].oid;
    }
    return null;
  }

  async function loadMore(): Promise<void> {
    const selection = untrack(() => branchFilter);
    const local = untrack(() => localOnly);
    const hideRemotes = untrack(() => hideRemoteOnly);
    const filePath = untrack(() => filePathFilter.trim());
    const generation = reloader.generation;
    const queryIsCurrent = (): boolean =>
      generation === reloader.generation &&
      selection === untrack(() => branchFilter) &&
      local === untrack(() => localOnly) &&
      hideRemotes === untrack(() => hideRemoteOnly) &&
      filePath === untrack(() => filePathFilter.trim());
    // `reload()` refreshed `branchList` already when the toggle is on.
    const { branches: filter, excludeBranches } = branchWalkQuery(
      untrack(() => branchList),
      selection,
      hideRemotes,
    );
    const cacheKey = snapshotKey(repoPath, selection, local, hideRemotes, filePath);
    loading = true;
    loadingMore = true;
    error = null;
    try {
      // Cursor resume (#431) for unfiltered / local-only views: gap-free and
      // immune to woven stash rows that a numeric skip miscounts (#432).
      // Filtered queries keep the numeric skip (real-commit count) path — the
      // cursor is keyed to the unfiltered walk. Skip by the number of REAL
      // commits, never commits.length (woven stash rows aren't walk steps).
      // An exclusion changes the walk just like a selection does, so it also
      // rules out the cursor (which is keyed to the unfiltered walk) (#515).
      const useCursor =
        filter === null && excludeBranches === null && !filePath && nextCursor !== null;
      const page = await gitLog(repoPath, {
        limit: PAGE_SIZE,
        ...(useCursor
          ? { cursor: nextCursor as string }
          : { skip: countGraphWalkCommits(commits) }),
        ...(filter ? { branches: filter } : {}),
        ...(excludeBranches ? { exclude_branches: excludeBranches } : {}),
        ...(local ? { local_only: true } : {}),
        ...(filePath ? { file_path: filePath } : {}),
      });
      // A path/branch query can change while a deeper page is in flight. The
      // page belongs to the captured walk and must never append into the new
      // result set (or overwrite its cache) after that change.
      if (!queryIsCurrent()) return;
      commits = [...commits, ...page.commits];
      refs = { ...refs, ...page.refs };
      hasMore = page.has_more;
      nextCursor = page.next_cursor;
      // Snapshot page 0 for instant remount paint (#255) — deliberately not
      // the full paged history, which can grow unbounded. The stored cursor
      // matches the stored slice so a remount resumes without a gap.
      const slice = commits.slice(0, PAGE_SIZE);
      cacheSnapshot(cacheKey, {
        commits: slice,
        refs,
        hasMore: hasMore || commits.length > PAGE_SIZE,
        headOid,
        headBranch,
        detached,
        workingChanges,
        nextCursor: cursorForSlice(slice),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (queryIsCurrent()) loading = false;
      loadingMore = false;
    }
  }

  // Genuine side effect (IPC) keyed on the repo this tab shows and the
  // active branch filter; reload reads the filter via untrack, so the
  // explicit reads here are the only dependencies.
  $effect(() => {
    void repoPath;
    void branchFilter;
    void localOnly;
    void hideRemoteOnly;
    untrack(() => void reload());
  });

  // Live refresh (#365, #432): watch the repo and reload when git state
  // changes underneath us. Local mutations (this app's own actions) refresh
  // directly via `reload()` in their handlers and are filtered out here
  // (mirroring scm.svelte.ts:222) so an action's own notify echo doesn't
  // trigger a redundant second reload. A short debounce folds the watcher
  // burst a pull produces into one call; `reload()` itself never drops a
  // request, so dropping the old skip-while-loading guard is safe.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const repo = repoPath;
    let disposed = false;
    let unsub: (() => void) | undefined;
    void gitWatchRepo(repo);
    void subscribeGitChanges((change) => {
      if (!shouldReloadGraphForChange(change)) return;
      if (change.repoRoot && directoryKey(change.repoRoot) !== directoryKey(repo)) return;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (!disposed) void reload();
      }, 300);
    }).then((u) => {
      if (disposed) u();
      else unsub = u;
    });
    return () => {
      disposed = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
      unsub?.();
      void gitUnwatchRepo(repo);
      if (filePathReloadTimer !== null) clearTimeout(filePathReloadTimer);
    };
  });

  // F5 refresh (#432): register this pane's fetch+reload with the command bus
  // so the `gitGraph.refresh` keybinding reaches it — only for the active
  // pane, and visible to the terminal's key-ownership gate (no shadow window
  // listener). Registered per pane id; a remount replaces the prior handler.
  $effect(() => {
    const id = paneId ?? windowTabsManager.activePaneId ?? "default";
    return registerGraphRefresher(id, () => void refreshWithFetch());
  });

  // Ctrl+Up/Down branch-line jumps (#530): same per-pane bus shape as F5, for
  // the same reason — a window listener here would be unrebindable and would
  // fire for every mounted graph tab, active or not.
  $effect(() => {
    const id = paneId ?? windowTabsManager.activePaneId ?? "default";
    return registerGraphSelectionStepper(id, (dir) => void stepSelectionOnBranchLine(dir));
  });

  // ----- Branch filter popover (#342) -----

  let branchPopoverOpen = $state(false);
  let branchQuery = $state("");
  let branchList = $state<Array<{ name: string; remote: boolean }>>([]);

  // Branch → creator map for the author filter (#376); loaded lazily with
  // the branch list (the creator walk is deferred work). Both are fetched only
  // when the popover first opens and kept cached until a graph reload
  // invalidates them (#431) — the popover is closed during the frequent
  // watcher reloads, so the refetch (cheap now: gitBranchAuthors is cached
  // per repo by tip OIDs in the backend) happens lazily on the next open.
  let branchAuthors = $state<Record<string, string>>({});
  let branchDataLoaded = false;

  /** Refresh the popover's branch list. Also driven by `reload()` while the
   *  hide-remote-only toggle is on — that filter is computed from this list,
   *  so it can't wait for the popover to be opened (#515). */
  async function loadBranchList(): Promise<void> {
    try {
      const r = await gitRefs(repoPath);
      branchList = [
        ...r.local_branches.map((b) => ({ name: b.name, remote: false })),
        ...r.remote_branches.map((b) => ({ name: b.name, remote: true })),
      ];
    } catch {
      // Keep the last known list. Blanking it would make the hide toggle
      // subtract nothing while still reading as on — and cache those
      // unexcluded rows under the toggle's snapshot key (#416).
    }
  }

  async function toggleBranchPopover(): Promise<void> {
    branchPopoverOpen = !branchPopoverOpen;
    if (branchPopoverOpen && !branchDataLoaded) {
      branchDataLoaded = true;
      await loadBranchList();
      try {
        const authors = await gitBranchAuthors(repoPath);
        branchAuthors = Object.fromEntries(authors.map((a) => [a.name, a.author]));
      } catch {
        branchAuthors = {};
      }
    }
  }

  const authorOptions = $derived(
    [...new Set(Object.values(branchAuthors).filter((a) => a))].sort(),
  );

  const filteredBranchList = $derived(
    branchList.filter((b) => b.name.toLowerCase().includes(branchQuery.toLowerCase())),
  );

  /** null = all branches; [] = none (#413). */
  function setBranchFilter(next: string[] | null): void {
    branchFilter = next;
    savePersisted(BRANCH_FILTER_KEY, branchFilter);
    // The selected commit (or the PR dropdown's anchor row) may not exist in
    // the new subset.
    closeDetails();
    closePrDetail();
  }

  /** Remote refs no local branch tracks — the set the bulk toggle hides. */
  const remoteOnlySet = $derived(new Set(remoteOnlyBranchNames(branchList as BranchListEntry[])));

  function isHiddenAsRemoteOnly(name: string): boolean {
    return hideRemoteOnly && remoteOnlySet.has(name);
  }

  function isBranchShown(name: string): boolean {
    if (isHiddenAsRemoteOnly(name)) return false;
    return branchFilter === null || branchFilter.includes(name);
  }

  /** Checkbox semantics: from "all", unchecking X shows everything but X;
   *  re-checking the last missing branch collapses back to "all". */
  function toggleBranch(name: string): void {
    const all = branchList.map((b) => b.name);
    const cur = branchFilter ?? all;
    const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
    setBranchFilter(next.length === all.length ? null : next);
  }

  /** Select/deselect-all (#413): everything shown → none; anything else → all. */
  const allBranchesShown = $derived(branchFilter === null);
  function toggleAllBranches(): void {
    setBranchFilter(allBranchesShown ? [] : null);
  }

  // ----- Author checkboxes (#411, #412): batch-toggle an author's branches -----

  /** Branches the author checkbox governs. Branches the bulk remote-only
   *  toggle is hiding (#515) are out of play on the per-branch axis, so they
   *  neither uncheck their author nor get (de)selected by clicking them. */
  function branchesByAuthor(author: string): string[] {
    return branchList
      .filter((b) => branchAuthors[b.name] === author && !isHiddenAsRemoteOnly(b.name))
      .map((b) => b.name);
  }

  /** An author reads as checked when every branch they created is shown. */
  function isAuthorShown(author: string): boolean {
    const names = branchesByAuthor(author);
    return names.length > 0 && names.every((n) => isBranchShown(n));
  }

  /** Ticking an author selects all their branches; unticking deselects them. */
  function toggleAuthor(author: string): void {
    const all = branchList.map((b) => b.name);
    const cur = new Set(branchFilter ?? all);
    const names = branchesByAuthor(author);
    if (names.length > 0 && names.every((n) => cur.has(n))) {
      for (const n of names) cur.delete(n);
    } else {
      for (const n of names) cur.add(n);
    }
    setBranchFilter(cur.size === all.length ? null : [...cur]);
  }

  // One shared formatter: constructing Intl state per row per render is a
  // measurable cost at hundreds of rows (#256).
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  function formatDate(unixSeconds: number): string {
    // Today's commits read as an age ("5 minutes ago", #389); older ones
    // keep the date. Recomputed on graph reloads (the repo watcher makes
    // those frequent), so the wording stays fresh enough without a timer.
    return compactRelativeTimeToday(unixSeconds, Date.now()) ?? dateFormatter.format(new Date(unixSeconds * 1000));
  }

  function colorOf(index: number): string {
    return GRAPH_PALETTE[index % GRAPH_PALETTE.length];
  }

  /** Split the uncommitted branch at HEAD: [0, headRowInLine] renders gray
   *  dashed; the remainder renders in its branch color. */
  function splitUncommitted(line: BranchLine): { dirty: BranchLine; rest: BranchLine } {
    const headRow = displayCommits.findIndex((c) => c.oid === headOid);
    const split = Math.max(
      1,
      line.points.findIndex((p) => p.row === headRow),
    );
    return {
      dirty: { colorIndex: line.colorIndex, points: line.points.slice(0, split + 1) },
      rest: { colorIndex: line.colorIndex, points: line.points.slice(split) },
    };
  }

  /** Window tracking + near-bottom incremental loading. */
  function handleScroll(event: Event): void {
    const el = event.target as HTMLElement;
    scrollTop = el.scrollTop;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 20) {
      // loadMore() resumes from the cursor (unfiltered) or the real-commit
      // count (filtered); both are immune to the woven-stash off-by-N (#432).
      if (!loading && hasMore) void loadMore();
    }
  }

  /** Combined ref chips — grouping math lives in domain/git-graph.ts. */
  function chipsFor(oid: string): RefChips {
    return groupRefChips(refs[oid] ?? [], headBranch);
  }

  /** Open PR badge for a local-branch chip, if any (#448). */
  function prForHead(name: string): OpenPr | undefined {
    return prsByBranch.get(name);
  }

  /** Open PR badge for a remote-only chip, keyed by its branch (not the
   *  full `remote/branch` name) so `origin/feature` still matches a PR
   *  whose head is `feature`. */
  function prForRemote(chip: RemoteRefChip): OpenPr | undefined {
    return prsByBranch.get(chip.branch);
  }

  /** Toggle the in-app PR details dropdown for `pr`, anchored under `commit`'s
   *  row (#459). Called from a badge inside a clickable commit row, so the
   *  click must not also select the row. Clicking the same badge again closes
   *  it; opening it closes any open commit details (one expansion at a time). */
  function togglePrDetail(event: MouseEvent, commit: CommitInfo, pr: OpenPr): void {
    event.stopPropagation();
    if (prDetail?.oid === commit.oid && prDetail.pr.number === pr.number) {
      closePrDetail();
      return;
    }
    closeDetails();
    prDetailHeight = 0;
    prDetail = { oid: commit.oid, pr };
  }

  /** Whether `pr` under `commit` is the currently open dropdown. */
  function isPrDetailOpen(commit: CommitInfo, pr: OpenPr): boolean {
    return prDetail?.oid === commit.oid && prDetail.pr.number === pr.number;
  }

  /** Open a PR's page in the default browser (host-pinned to github.com);
   *  the dropdown's "Open on GitHub" action. */
  function openPrExternal(pr: OpenPr): void {
    void openExternalUrl(pr.htmlUrl);
  }

  // ----- Commit context menu (VSCode "Git Graph"-parity actions) -----

  interface Menu {
    x: number;
    y: number;
    commit: CommitInfo;
    /** Branch to attach on Checkout, or null → detached checkout of the OID. */
    checkoutBranch: string | null;
    /** Set when the menu was opened from a specific branch badge (#405):
     *  branch-scoped entries (Delete Branch) show only this branch. */
    scopedBranch: string | null;
    /** Set when opened from a remote-only branch chip (#432): the menu offers
     *  a tracking checkout (`git checkout -b <branch> --track <remote>/<branch>`). */
    remote: RemoteRefChip | null;
  }
  let menu = $state<Menu | null>(null);
  // Inline name prompt for Create Branch / Create Tag.
  let prompt = $state<{ kind: "branch" | "tag"; oid: string; value: string } | null>(null);
  // Suboption dialogs (#406): reset modes and delete-branch variants open as
  // a modal instead of a cascading submenu.
  type ActionModal =
    | { kind: "reset"; oid: string; summary: string }
    | { kind: "deleteBranch"; name: string; remotes: string[] };
  let actionModal = $state<ActionModal | null>(null);

  function localBranchAt(oid: string): string | null {
    const ref = (refs[oid] ?? []).find((r) => r.kind === "LocalBranch");
    return ref ? ref.name : null;
  }

  let menuEl = $state<HTMLElement | null>(null);

  // Keep the menu on screen (VSCode behavior): after it renders, pull it back
  // inside the viewport. Bounds converted with clientToFixed so the clamp
  // lives in the same fixed-CSS space as the cursor coords (see #221 lesson).
  $effect(() => {
    const m = menu;
    const el = menuEl;
    if (!m || !el) return;
    const pad = 8;
    const vw = clientToFixed(window.innerWidth);
    const vh = clientToFixed(window.innerHeight);
    let x = m.x;
    let y = m.y;
    if (x + el.offsetWidth > vw - pad) x = Math.max(pad, vw - el.offsetWidth - pad);
    if (y + el.offsetHeight > vh - pad) y = Math.max(pad, vh - el.offsetHeight - pad);
    if (x !== m.x || y !== m.y) menu = { ...m, x, y };
  });

  function openMenu(
    event: MouseEvent,
    commit: CommitInfo,
    scopedBranch: string | null = null,
    remote: RemoteRefChip | null = null,
  ): void {
    event.preventDefault();
    prompt = null;
    // clientToFixed: the menu is position:fixed, so cursor coordinates must be
    // converted into fixed-CSS space or the menu drifts under CSS zoom (same
    // transform ContextMenu uses — see domain/zoom.ts).
    menu = {
      x: clientToFixed(event.clientX),
      y: clientToFixed(event.clientY),
      commit,
      checkoutBranch: scopedBranch ?? localBranchAt(commit.oid),
      scopedBranch,
      remote,
    };
  }

  /** Tracking checkout of a remote-only branch (#432): create/switch to a
   *  local branch tracking `<remote>/<branch>`. */
  function checkoutTracking(chip: RemoteRefChip): void {
    closeMenu();
    void (async () => {
      try {
        await gitCheckoutTracking(repoPath, chip.remote, chip.branch);
        toastStore.success(`Checked out ${chip.branch} (tracking ${chip.name})`);
      } catch (err) {
        toastStore.error(err instanceof Error ? err.message : String(err));
      } finally {
        await reload();
        notifyLocalGitChange(repoPath);
      }
    })();
  }

  function closeMenu(): void {
    menu = null;
    prompt = null;
  }

  /** Open a suboption modal (#406), closing the context menu behind it. */
  function openActionModal(modal: ActionModal): void {
    actionModal = modal;
    menu = null;
  }

  /** Run the chosen modal action and dismiss the modal. The action runs
   *  FIRST: its closure reads the template's {@const modal}, a derived that
   *  recomputes to null the instant actionModal clears. */
  function confirmModalAction(fn: () => void): void {
    fn();
    actionModal = null;
  }

  /** Right-click on the backdrop: open the menu for the commit row under the
   *  cursor in ONE click (instead of the first click merely cancelling the
   *  previous menu, #263). Falls back to just closing over non-commit areas. */
  function backdropContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const row = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((el) => el.classList.contains("commit-row")) as HTMLElement | undefined;
    const commit = row?.dataset.oid
      ? displayCommits.find((c) => c.short_oid === row.dataset.oid)
      : undefined;
    if (commit && commit.oid !== UNCOMMITTED) {
      openMenu(event, commit);
    } else {
      closeMenu();
    }
  }

  /** Run a mutating action, then reload the graph and refresh the SCM panel
   *  (always — a conflicting op still mutates the repo). */
  async function runAction(label: string, fn: () => Promise<void>): Promise<void> {
    closeMenu();
    try {
      await fn();
      toastStore.success(`${label} done`);
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : String(err));
    } finally {
      // Reload through the single entry point, then notify OTHER consumers
      // (SCM panel, badges); the graph's own subscriber filters `local` so
      // this notify doesn't echo back into a redundant second reload (#432).
      await reload();
      notifyLocalGitChange(repoPath);
    }
  }

  // Pull offer after checking out a branch whose upstream is ahead (#377).
  let pullOffer = $state<{ branch: string; behind: number } | null>(null);

  function checkout(m: Menu): void {
    const branch = m.checkoutBranch;
    closeMenu();
    void (async () => {
      try {
        await gitCheckout(repoPath, branch ?? m.commit.oid);
        toastStore.success("Checkout done");
        // Only after a SUCCESSFUL branch checkout: a pull acts on the
        // current branch, so offering it after a failure would pull the
        // wrong branch.
        if (branch) {
          try {
            const behind = await gitBranchBehindUpstream(repoPath, branch);
            if (behind !== null && behind > 0) pullOffer = { branch, behind };
          } catch {
            /* no upstream info — nothing to offer */
          }
        }
      } catch (err) {
        toastStore.error(err instanceof Error ? err.message : String(err));
      } finally {
        await reload();
        notifyLocalGitChange(repoPath);
      }
    })();
  }

  function confirmPull(): void {
    pullOffer = null;
    void runAction("Pull", () => gitPull(repoPath));
  }
  function cherryPick(oid: string): void {
    void runAction("Cherry-pick", () => gitCherryPick(repoPath, oid));
  }
  function revert(oid: string): void {
    void runAction("Revert", () => gitRevert(repoPath, oid));
  }
  function merge(m: Menu): void {
    void runAction("Merge", () => gitMerge(repoPath, m.checkoutBranch ?? m.commit.oid));
  }
  function rebase(oid: string): void {
    void runAction("Rebase", () => gitRebase(repoPath, oid));
  }
  function reset(oid: string, mode: ResetMode): void {
    void runAction(`Reset (${mode})`, () => gitReset(repoPath, oid, mode));
  }

  /** Delete a local branch; optionally its counterpart on each tracking
   *  remote (#371). Safe (-d) unless `force`; git's refusals (unmerged,
   *  checked out) surface as the toast. */
  function deleteBranch(name: string, force: boolean, remotes: string[]): void {
    void runAction(`Delete branch '${name}'`, async () => {
      await gitDeleteBranch(repoPath, name, force);
      for (const remote of remotes) {
        await gitDeleteRemoteBranch(repoPath, remote, name);
      }
    });
  }

  /** Delete a remote-only branch chip like "origin/feat/x" (#371). */
  function deleteRemoteChip(chip: RemoteRefChip): void {
    void runAction(`Delete ${chip.name}`, () =>
      gitDeleteRemoteBranch(repoPath, chip.remote, chip.branch),
    );
  }

  function startPrompt(kind: "branch" | "tag", oid: string): void {
    prompt = { kind, oid, value: "" };
    menu = null;
  }
  function confirmPrompt(): void {
    if (!prompt) return;
    const { kind, oid, value } = prompt;
    const name = value.trim();
    if (name.length === 0) {
      prompt = null;
      return;
    }
    prompt = null;
    if (kind === "branch") {
      void runAction("Create branch", () => gitCreateBranch(repoPath, name, oid, false));
    } else {
      void runAction("Create tag", () => gitCreateTag(repoPath, name, oid));
    }
  }

  async function copyToClipboard(text: string, what: string): Promise<void> {
    closeMenu();
    try {
      await navigator.clipboard.writeText(text);
      toastStore.clipboard(`Copied ${what}`, false);
    } catch {
      toastStore.error(`Could not copy ${what}`);
    }
  }

  // F5 (#370): refresh the graph INCLUDING a fetch from every remote, so
  // remote-branch chips and ahead/behind state update — a plain reload only
  // re-reads local refs. Guarded against overlap; failures (offline, auth)
  // toast git's own message but still reload local state.
  /** Blur a commit row / tab that the pointer left focused, so the F5 keypress
   *  doesn't flip it into `:focus-visible` and paint the default white ring
   *  (#433). Focus falls to <body>; keyboard Tab navigation is unaffected. */
  function dropTransientFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches(".commit-row, .tab")) {
      active.blur();
    }
  }

  let fetching = $state(false);
  async function refreshWithFetch(): Promise<void> {
    if (fetching) return;
    // Kill the post-F5 focus ring (#433): F5 is a keyboard event, so it
    // promotes whatever the pointer last left focused — the clicked commit row
    // or the active tab — to `:focus-visible`, painting the browser's default
    // white outline. F5 is an app-wide refresh, not list navigation, so we drop
    // that focus. Genuine keyboard navigation is untouched: Tab still lands on
    // (and rings) rows/tabs afterward; we only blur an element the mouse focused.
    dropTransientFocus();
    fetching = true;
    // Immediate feedback (#417): the fetch can take seconds, and without an
    // opening toast F5 looks like it did nothing (or worse, like it merely
    // focus-highlighted the selected row).
    toastStore.show("Refreshing graph…", "info");
    try {
      await gitFetch(repoPath);
      // Optional local-branch sync (#432): fast-forward every local branch
      // strictly behind its upstream. Diverged branches are never touched —
      // they're surfaced in a toast so the user knows a manual merge is due.
      if (settingsStore.f5SyncsLocalBranches) {
        try {
          const sync = await gitSyncLocalBranches(repoPath);
          if (sync.diverged.length > 0) {
            toastStore.show(
              `Diverged (not synced): ${sync.diverged.join(", ")}`,
              "error",
              { duration: 6000 },
            );
          }
          if (sync.fast_forwarded.length > 0) {
            toastStore.success(
              `Fast-forwarded ${sync.fast_forwarded.length} branch${sync.fast_forwarded.length === 1 ? "" : "es"}`,
            );
          } else {
            toastStore.success("Fetched from remotes");
          }
        } catch (err) {
          toastStore.error(err instanceof Error ? err.message : String(err));
        }
      } else {
        toastStore.success("Fetched from remotes");
      }
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : String(err));
    } finally {
      fetching = false;
      await reload();
      notifyLocalGitChange(repoPath);
    }
  }

  // F5 is handled by the `gitGraph.refresh` command (registered above, gated
  // on the active graph pane) — NOT a raw window listener here (#432). A shadow
  // window binding was invisible to the keybindings registry and the terminal
  // key-ownership gate, and fired for every mounted graph tab, active or not.
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && branchPopoverOpen) {
      branchPopoverOpen = false;
      return;
    }
    if (event.key === "Escape" && actionModal) {
      actionModal = null;
      return;
    }
    if (event.key === "Escape" && columnMenu) {
      columnMenu = null;
      return;
    }
    if (event.key === "Escape" && prDetail) {
      closePrDetail();
      return;
    }
    if (event.key === "Escape" && (menu || prompt)) closeMenu();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="git-graph-view" data-testid="git-graph-view">
  {#if error}
    <div class="graph-status error">{error}</div>
  {:else}
    {#if detachedIndicator}
      <!-- Standing detached-HEAD banner (#524): outside the header row so it
           never disturbs column layout, and outside every menu so it lasts as
           long as the state does. -->
      <div
        class="detached-banner"
        data-testid="git-graph-detached-badge"
        role="status"
        title={detachedIndicator.title}
      >
        {detachedIndicator.label}
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- right-click opens the column-visibility menu; not reachable by keyboard by design (parity with the row context menu) -->
    <div class="graph-header" role="row" tabindex="-1" style:padding-left="{effectiveGraphWidth + 20}px" oncontextmenu={openColumnMenu}>
      <button
        class="branch-filter-btn"
        class:filtered={branchFilter !== null || localOnly || hideRemoteOnly || !!filePathFilter.trim()}
        onclick={() => void toggleBranchPopover()}
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
        {#if branchFilter}<span class="bf-count">{branchFilter.length}</span>{/if}
      </button>
      {#if branchPopoverOpen}
        <button
          class="menu-backdrop"
          aria-label="Close branch filter"
          onclick={() => (branchPopoverOpen = false)}
        ></button>
        <div class="branch-popover" data-testid="branch-popover">
          <div class="bf-heading">Commits</div>
          <input
            class="bf-path-search"
            placeholder="Filter commits by file path…"
            aria-label="Filter commits by file path"
            data-testid="git-graph-file-path-filter"
            value={filePathFilter}
            oninput={onFilePathFilterInput}
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
              <input type="checkbox" checked={localOnly} onchange={toggleLocalOnly} />
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
              <input type="checkbox" checked={hideRemoteOnly} onchange={toggleHideRemoteOnly} />
              <span class="bf-name">Hide remote-only branches</span>
            </label>
            <!-- Select/deselect all (#413). -->
            <label class="bf-row bf-all" title="Select or deselect every branch">
              <input
                type="checkbox"
                checked={allBranchesShown}
                indeterminate={!allBranchesShown && (branchFilter?.length ?? 0) > 0}
                onchange={toggleAllBranches}
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
                    checked={isAuthorShown(author)}
                    onchange={() => toggleAuthor(author)}
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
                  onchange={() => toggleBranch(b.name)}
                />
                <span class="bf-name">{b.name}</span>
                {#if b.remote}<span class="bf-remote">remote</span>{/if}
                <button
                  class="bf-only"
                  title="Show only {b.name}"
                  disabled={isHiddenAsRemoteOnly(b.name)}
                  onclick={(e) => {
                    e.preventDefault();
                    setBranchFilter([b.name]);
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
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- mouse-drag resize handles; role=separator conveys the semantics, keyboard resize is a separate unimplemented feature -->
      <span
        class="col-handle handle-graph"
        class:active={graphColResizing}
        style:left="{effectiveGraphWidth + 6}px"
        onmousedown={startGraphColResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize graph column"
        data-testid="handle-graph"
      ></span>
      <span class="gh-message" title={filePathFilter.trim() || "Message"}>
        {filePathFilter.trim() ? `Path: ${filePathFilter.trim()}` : "Message"}
      </span>
      {#if shownColumns.author}
        <span class="gh-author" style:width="{authorCol.width}px">
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <span
            class="col-handle handle-in-cell"
            class:active={authorCol.isResizing}
            onmousedown={authorCol.startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize author column"
            data-testid="handle-author"
          ></span>
          Author
        </span>
      {/if}
      {#if shownColumns.date}
        <span class="gh-date" style:width="{dateCol.width}px">
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <span
            class="col-handle handle-in-cell"
            class:active={dateCol.isResizing}
            onmousedown={dateCol.startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize date column"
            data-testid="handle-date"
          ></span>
          Date
        </span>
      {/if}
      {#if shownColumns.commit}<span class="gh-oid">Commit</span>{/if}
      {#if shownColumns.parent}<span class="gh-oid gh-parent">Parent</span>{/if}
    </div>
    {#if columnMenu}
      <button
        class="menu-backdrop"
        aria-label="Close column menu"
        onclick={() => (columnMenu = null)}
        oncontextmenu={(e) => { e.preventDefault(); columnMenu = null; }}
      ></button>
      <div
        class="commit-menu"
        data-testid="git-graph-column-menu"
        role="menu"
        tabindex="-1"
        style="left: {columnMenu.x}px; top: {columnMenu.y}px;"
      >
        {#each [["author", "Author"], ["date", "Date"], ["commit", "Commit"], ["parent", "Parent"]] as [id, label] (id)}
          <button
            class="menu-item"
            role="menuitemcheckbox"
            aria-checked={shownColumns[id as ColumnId]}
            onclick={() => toggleColumn(id as ColumnId)}
          >
            <span class="col-check">{shownColumns[id as ColumnId] ? "✓" : ""}</span>
            {label}
          </button>
        {/each}
        <div class="menu-sep"></div>
        <!-- Hash/parents/author/date inside the commit detail block (#402):
             hidden by default, toggleable here. -->
        <button
          class="menu-item"
          role="menuitemcheckbox"
          aria-checked={showDetailMeta}
          onclick={toggleDetailMeta}
          data-testid="toggle-detail-meta"
        >
          <span class="col-check">{showDetailMeta ? "✓" : ""}</span>
          Details metadata
        </button>
        <!-- Dim merge-commit rows to cut history noise (#458). -->
        <button
          class="menu-item"
          role="menuitemcheckbox"
          aria-checked={muteMerges}
          onclick={toggleMuteMerges}
          data-testid="toggle-mute-merges"
        >
          <span class="col-check">{muteMerges ? "✓" : ""}</span>
          Mute merge commits
        </button>
      </div>
    {/if}
    {#if commits.length === 0 && loading}
      <div class="graph-status">Loading history…</div>
    {:else if commits.length === 0}
      <div class="graph-status">No commits.</div>
    {:else}
    <div class="graph-scroller" onscroll={handleScroll} bind:this={scrollerEl} bind:clientHeight={viewportHeight}>
      <div class="graph-body" style:height="{graphHeight}px">
        <!-- Clip window for the lane SVG: when the user narrows the graph
             column below the lane-derived width, overflow is cut (#341). -->
        <div class="graph-clip" style:width="{effectiveGraphWidth}px">
        <svg
          class="graph-underlay"
          width={graphWidth}
          height={graphHeight}
          aria-hidden="true"
        >
          {#each visibleBranches as line, li (li)}
            {#if line === uncommittedBranch}
              {@const parts = splitUncommitted(line)}
              <path class="branch-halo" d={branchPath(parts.dirty, LANE_WIDTH, ROW_HEIGHT, rowExpand)} />
              <path
                d={branchPath(parts.dirty, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
                stroke="#808080"
                stroke-dasharray="4 3"
                stroke-width="2"
                fill="none"
              />
              {#if parts.rest.points.length > 1}
                <path class="branch-halo" d={branchPath(parts.rest, LANE_WIDTH, ROW_HEIGHT, rowExpand)} />
                <path
                  d={branchPath(parts.rest, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
                  stroke={colorOf(line.colorIndex)}
                  stroke-width="2"
                  fill="none"
                />
              {/if}
            {:else}
              <path class="branch-halo" d={branchPath(line, LANE_WIDTH, ROW_HEIGHT, rowExpand)} />
              <path
                d={branchPath(line, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
                stroke={colorOf(line.colorIndex)}
                stroke-width="2"
                fill="none"
              />
            {/if}
          {/each}
          {#each visibleVertices as { vertex, vi } (vi)}
            {@const cx = vertex.lane * LANE_WIDTH + LANE_WIDTH / 2}
            {@const cy = vi * ROW_HEIGHT + ROW_HEIGHT / 2 + (rowExpand && vi > rowExpand.afterRow ? rowExpand.extra : 0)}
            {#if displayCommits[vi]?.oid === UNCOMMITTED}
              <!-- Open circle at the uncommitted-changes row (reference default). -->
              <circle {cx} {cy} r="4" fill="var(--background-card)" stroke="#808080" stroke-width="2" />
            {:else if displayCommits[vi]?.stash}
              <!-- Stash: ring marker. -->
              <circle {cx} {cy} r="4.5" fill="none" stroke={colorOf(vertex.colorIndex)} stroke-width="2" />
              <circle {cx} {cy} r="2" fill={colorOf(vertex.colorIndex)} />
            {:else}
              <circle {cx} {cy} r="4" fill={colorOf(vertex.colorIndex)} />
            {/if}
          {/each}
        </svg>
        </div>

        <!-- PR badge (#448/#459): CI-colored, glyph-decorated, and a toggle for
             the in-app details dropdown. Shared by both the local-branch and
             remote-only chip render sites. -->
        {#snippet prBadge(commit: CommitInfo, pr: OpenPr)}
          {@const p = prBadgePresentation(pr)}
          <button
            type="button"
            class="ref ref-pr"
            class:draft={pr.draft}
            class:ci-success={p.ciClass === "ci-success"}
            class:ci-failure={p.ciClass === "ci-failure"}
            class:ci-pending={p.ciClass === "ci-pending"}
            class:open={isPrDetailOpen(commit, pr)}
            title={pr.title}
            aria-expanded={isPrDetailOpen(commit, pr)}
            onclick={(e) => togglePrDetail(e, commit, pr)}
          >
            ⇄ #{pr.number}
            {#if p.reviewGlyph}<span class="pr-review" aria-hidden="true">{p.reviewGlyph}</span>{/if}
            {#if p.commentCount !== null}<span class="pr-comments" title="{p.commentCount} comments">🗨 {p.commentCount}</span>{/if}
          </button>
        {/snippet}

        {#each visibleRows as { commit, index } (commit.oid)}
          {@const chips = chipsFor(commit.oid)}
          {@const synthetic = commit.oid === UNCOMMITTED}
          <div
            class="commit-row"
            class:selected={selected?.oid === commit.oid}
            class:is-head={chips.isHead}
            class:is-merge={muteMerges && !synthetic && commit.parents.length >= 2}
            class:uncommitted={synthetic}
            style:padding-left="{effectiveGraphWidth + 20}px"
            style:top="{rowY(index)}px"
            data-oid={commit.short_oid}
            role="button"
            tabindex="0"
            onclick={() => void selectCommit(commit)}
            onkeydown={(e) => { if (e.key === "Enter") void selectCommit(commit); }}
            oncontextmenu={(e) => { if (!synthetic) openMenu(e, commit); else e.preventDefault(); }}
          >
            {#if synthetic}
              <span class="summary uncommitted-label">{commit.summary}</span>
            {:else}
              {#if commit.stash}
                <span class="ref ref-stash">{commit.stash}</span>
              {/if}
              <!-- PR numbers already badged by a local-branch chip this row, so the
                   remote-only loop below can skip them (#448) — a branch with an
                   in-sync remote never needs the same PR badged twice. -->
              {@const rowPrNumbers = new Set(
                chips.heads.map((h) => prForHead(h.name)?.number).filter((n) => n !== undefined),
              )}
              {#each chips.heads as head (head.name)}
                <!-- svelte-ignore a11y_no_static_element_interactions -- right-click scopes the row context menu to this badge (#405); the row itself stays the keyboard target -->
                <span
                  class="ref ref-branch"
                  class:ref-active={head.active}
                  oncontextmenu={(e) => { e.stopPropagation(); openMenu(e, commit, head.name); }}
                >
                  {head.name}
                  {#each head.remotes as remote (remote)}
                    <span class="ref-remote-sub" title="{remote}/{head.name} is at this commit">{remote}</span>
                  {/each}
                </span>
                {#if prForHead(head.name)}
                  {@render prBadge(commit, prForHead(head.name)!)}
                {/if}
              {/each}
              {#each chips.remotes as remote (remote.name)}
                <!-- svelte-ignore a11y_no_static_element_interactions -- right-click scopes the row context menu to this remote branch for a tracking checkout (#432); the row itself stays the keyboard target -->
                <span
                  class="ref ref-remote"
                  title="Remote-only branch — no local branch tracks {remote.name}. Right-click to checkout."
                  oncontextmenu={(e) => { e.stopPropagation(); openMenu(e, commit, null, remote); }}
                >
                  <svg class="remote-cloud" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.8-.9 2.9 2.9 0 0 1-.5 5.9z" />
                  </svg>{remote.name}
                </span>
                {#if prForRemote(remote) && !rowPrNumbers.has(prForRemote(remote)!.number)}
                  {@render prBadge(commit, prForRemote(remote)!)}
                {/if}
              {/each}
              {#each chips.tags as tag (tag)}
                <span class="ref ref-tag">{tag}</span>
              {/each}
              <span class="summary" title={commit.summary}>{commit.summary}</span>
              {#if shownColumns.author}<span class="author" style:width="{authorCol.width}px">{commit.author_name}</span>{/if}
              {#if shownColumns.date}<span class="date" style:width="{dateCol.width}px">{formatDate(commit.author_time)}</span>{/if}
              {#if shownColumns.commit}<span class="oid">{commit.short_oid}</span>{/if}
              {#if shownColumns.parent}<span class="oid parent-col">{commit.parents.map((p) => p.slice(0, 7)).join(" ") || "—"}</span>{/if}
            {/if}
          </div>
          {#if selected?.oid === commit.oid}
            <!-- Inline details (VSCode Git Graph parity, #221): expands
                 directly below the clicked row; the graph SVG stretches by
                 detailsHeight so lower rows stay aligned. -->
            <!-- Left gutter matches the rows so the block clears the graph
                 lanes (they keep flowing to its left, as in VSCode). -->
            <div
              class="commit-detail-inline"
              data-testid="git-graph-detail"
              bind:offsetHeight={detailsHeight}
              style:margin-left="{effectiveGraphWidth + 12}px"
              style:top="{rowY(index) + ROW_HEIGHT}px"
            >
              <button class="detail-close" onclick={closeDetails} aria-label="Close details">✕</button>
              <div class="detail-columns">
                {#if !synthetic}
                  <div class="detail-meta-col">
                    <!-- Metadata hidden by default (#402); toggle via the
                         header context menu ("Details metadata"). -->
                    {#if showDetailMeta}
                      <div class="meta-line"><span class="meta-label">Commit:</span> <span class="meta-mono">{commit.oid}</span></div>
                      <div class="meta-line"><span class="meta-label">Parents:</span> <span class="meta-mono">{commit.parents.map((p) => p.slice(0, 8)).join(", ") || "—"}</span>{#if commit.parents.length > 1} <span class="meta-note">(merge of {commit.parents.length} parents)</span>{/if}</div>
                      <div class="meta-line"><span class="meta-label">Author:</span> {commit.author_name} &lt;{commit.author_email}&gt;</div>
                      <div class="meta-line"><span class="meta-label">Date:</span> {formatDate(commit.author_time)}</div>
                    {/if}
                    <p class="detail-message">{commit.summary.trimStart()}</p>
                  </div>
                {:else}
                  <!-- Uncommitted node (#466): the message area becomes an
                       editable commit box; its state machine lives in
                       domain/commit-panel. Ctrl+Enter commits, Esc closes. -->
                  <div class="detail-meta-col commit-box" data-testid="git-graph-commit-box">
                    <textarea
                      class="commit-box-input"
                      data-testid="git-graph-commit-message"
                      rows="2"
                      placeholder="Message (Ctrl+Enter to commit)"
                      aria-label="Commit message"
                      value={commitPanelStore.message}
                      oninput={(e) => commitPanelStore.setMessage(e.currentTarget.value)}
                      onkeydown={onCommitBoxKeydown}
                    ></textarea>
                    {#if commitPanelStore.error}
                      <div class="commit-box-error" role="alert">{commitPanelStore.error}</div>
                    {/if}
                    <div class="commit-box-actions">
                      <button
                        type="button"
                        class="commit-box-btn"
                        data-testid="git-graph-commit-btn"
                        disabled={!commitEnabled || commitPanelStore.committing}
                        title="Commit staged changes (Ctrl+Enter)"
                        onclick={() => void commitUncommitted()}
                      >
                        {commitButtonLabel(uncommittedStagedCount)}
                      </button>
                    </div>
                  </div>
                {/if}
                <div class="detail-files-col">
                  {#snippet stageActionIcon(kind: "stage" | "unstage")}
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      {#if kind === "stage"}
                        <path d="M8 3.5v9M3.5 8h9" />
                      {:else}
                        <path d="M3.5 8h9" />
                      {/if}
                    </svg>
                  {/snippet}
                  <!-- One-line path label (#500). The two halves are emitted with
                       NO whitespace between the tags on purpose: the row's text
                       content has to stay byte-identical to the path, since that
                       is what the user reads and what other specs match on. -->
                  {#snippet filePathLabel(path: string)}
                    {@const parts = splitPathForDisplay(path)}
                    <span class="file-path" title={path}><span class="file-dir">{parts.dir}</span><span class="file-name">{parts.name}</span></span>
                  {/snippet}
                  {#snippet fileDiff(file: DetailFile)}
                    {#if openDiffPath === file.path}
                      <div class="file-diff" data-testid="git-graph-file-diff">
                        {#if diffLoading}
                          <div class="diff-note">Loading diff…</div>
                        {:else if openDiff?.binary}
                          <div class="diff-note">Binary file changed</div>
                        {:else if openDiff && openDiff.lines.length > 0}
                          <div class="diff-lines">
                            {#each openDiff.lines as line (line.index)}
                              {#if line.kind !== "header" && line.kind !== "meta"}
                                <div class="diff-line {line.kind}">
                                  <span class="diff-gutter">{line.oldLine ?? ""}</span>
                                  <span class="diff-gutter">{line.newLine ?? ""}</span>
                                  <span class="diff-sigil">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "hunk" ? "@" : " "}</span>
                                  {#if line.kind === "hunk"}
                                    <span class="diff-content">{line.text}</span>
                                  {:else}
                                    <!-- highlightDiffLine output is hljs-generated/escaped HTML — safe sink. -->
                                    <span class="diff-content">{@html highlightDiffLine(line.text, file.path)}</span>
                                  {/if}
                                </div>
                              {/if}
                            {/each}
                          </div>
                        {:else}
                          <div class="diff-note">No changes to display</div>
                        {/if}
                      </div>
                    {/if}
                  {/snippet}
                  {#if synthetic}
                    {#if selectedFiles.length === 0}
                      <p class="file-empty">Working tree clean</p>
                    {:else}
                      {#each stageGroups as group (group.section)}
                        <div class="stage-group" data-section={group.section}>
                          <div class="stage-group-head">
                            <span class="stage-group-label">{group.label}</span>
                            <span class="stage-group-count">{group.files.length}</span>
                            {#if group.section === "staged"}
                              <button
                                type="button"
                                class="stage-all-btn"
                                title="Unstage all"
                                onclick={() => void unstagePaths(group.files.map((f) => f.path))}
                              >Unstage all</button>
                            {:else}
                              <button
                                type="button"
                                class="stage-all-btn"
                                title="Stage all"
                                onclick={() => void stagePaths(group.files.map((f) => f.path))}
                              >Stage all</button>
                            {/if}
                          </div>
                          <ul class="detail-files">
                            {#each group.files as file (group.section + ":" + file.path)}
                              <li>
                                <div class="detail-file-row">
                                  <button
                                    type="button"
                                    class="detail-file"
                                    class:open={openDiffPath === file.path}
                                    onclick={() => void toggleFileDiff(file)}
                                    title="Show diff"
                                  >
                                    <span class="file-status s-{file.status}">{file.status}</span>
                                    {@render filePathLabel(file.path)}
                                  </button>
                                  {#if group.section === "staged"}
                                    <button
                                      type="button"
                                      class="stage-btn"
                                      title="Unstage {file.path}"
                                      aria-label="Unstage {file.path}"
                                      onclick={() => void unstagePaths([file.path])}
                                    >{@render stageActionIcon("unstage")}</button>
                                  {:else}
                                    <button
                                      type="button"
                                      class="stage-btn"
                                      title="Stage {file.path}"
                                      aria-label="Stage {file.path}"
                                      onclick={() => void stagePaths([file.path])}
                                    >{@render stageActionIcon("stage")}</button>
                                  {/if}
                                </div>
                                {@render fileDiff(file)}
                              </li>
                            {/each}
                          </ul>
                        </div>
                      {/each}
                    {/if}
                  {:else}
                    <ul class="detail-files">
                      {#each selectedFiles as file (file.path + (file.staged ? ":s" : ""))}
                        <li>
                          <button
                            type="button"
                            class="detail-file"
                            class:open={openDiffPath === file.path}
                            onclick={() => void toggleFileDiff(file)}
                            title="Show diff"
                          >
                            <span class="file-status s-{file.status}">{file.status}</span>
                            {@render filePathLabel(file.path)}
                          </button>
                          {@render fileDiff(file)}
                        </li>
                      {:else}
                        <li class="file-empty">No file changes (or still loading…)</li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </div>
            </div>
          {/if}
          {#if prDetail?.oid === commit.oid}
            <!-- In-app PR details dropdown (#459): the second inline-expansion
                 source. Reuses the RowExpand stretch (prDetailHeight) so lower
                 rows stay aligned, exactly like the commit-details block. -->
            {@const pr = prDetail.pr}
            {@const ciLine = ciStatusLabel(pr.ciStatus)}
            {@const reviewLine = reviewDecisionLabel(pr.reviewDecision)}
            {@const description = prDescription(pr.body)}
            {@const comments = prDetailComments(pr.comments, Date.now())}
            <div
              class="commit-detail-inline pr-detail-inline"
              data-testid="git-graph-pr-detail"
              bind:offsetHeight={prDetailHeight}
              style:margin-left="{effectiveGraphWidth + 12}px"
              style:top="{rowY(index) + ROW_HEIGHT}px"
            >
              <button class="detail-close" onclick={closePrDetail} aria-label="Close PR details">✕</button>
              <div class="pr-detail-body">
                <div class="pr-detail-head">
                  <span class="pr-detail-number">#{pr.number}</span>
                  <span class="pr-detail-title">{pr.title}</span>
                  {#if pr.draft}<span class="pr-detail-chip draft">Draft</span>{/if}
                  <button type="button" class="pr-detail-open" onclick={() => openPrExternal(pr)}>
                    Open on GitHub ↗
                  </button>
                </div>
                {#if description}
                  <p class="pr-detail-description" data-testid="git-graph-pr-detail-body">{description}</p>
                {/if}
                {#if ciLine}
                  <div class="pr-detail-line">
                    <span class="pr-detail-label">CI:</span>
                    <span class="pr-detail-ci ci-{pr.ciStatus}">{ciLine}</span>
                  </div>
                {/if}
                {#if reviewLine}
                  <div class="pr-detail-line"><span class="pr-detail-label">Review:</span> {reviewLine}</div>
                {/if}
                {#if comments.length > 0}
                  <ul class="pr-detail-comments" data-testid="git-graph-pr-detail-comments">
                    {#each comments as comment}
                      <li class="pr-detail-comment">
                        <div class="pr-detail-comment-meta">
                          <span class="pr-detail-comment-author">{comment.author}</span>
                          {#if comment.time}<span class="pr-detail-comment-time">{comment.time}</span>{/if}
                        </div>
                        <div class="pr-detail-comment-body">{comment.body}</div>
                      </li>
                    {/each}
                  </ul>
                {:else if pr.commentCount != null && pr.commentCount > 0}
                  <div class="pr-detail-line">
                    <span class="pr-detail-label">Comments:</span> {pr.commentCount}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      </div>
      {#if loadingMore}
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
    <!-- Backdrop closes the menu on any outside interaction. -->
    <button
      class="menu-backdrop"
      aria-label="Close menu"
      onclick={closeMenu}
      oncontextmenu={backdropContextMenu}
    ></button>
    {@const m = menu}
    {@const menuChips = chipsFor(m.commit.oid)}
    <!-- Badge-scoped menu (#405): opened from a branch chip, only that
         branch's delete entry shows; opened from the row, all of them do. -->
    {@const deletableHeads = menuChips.heads.filter(
      (h) => !h.active && (m.scopedBranch === null || h.name === m.scopedBranch),
    )}
    <div
      class="commit-menu"
      data-testid="git-graph-menu"
      role="menu"
      tabindex="-1"
      bind:this={menuEl}
      style="left: {m.x}px; top: {m.y}px;"
    >
      <button class="menu-item" role="menuitem" onclick={() => startPrompt("branch", m.commit.oid)}>
        Create Branch…
      </button>
      <button class="menu-item" role="menuitem" onclick={() => startPrompt("tag", m.commit.oid)}>
        Create Tag…
      </button>
      <div class="menu-sep"></div>
      {#if m.remote}
        <!-- Tracking checkout of a remote-only branch (#432): create/switch to
             a local branch tracking <remote>/<branch>. -->
        <button
          class="menu-item"
          role="menuitem"
          data-testid="git-graph-checkout-tracking"
          onclick={() => checkoutTracking(m.remote!)}
        >
          Checkout {m.remote.branch} (tracking {m.remote.name})
        </button>
      {/if}
      <button class="menu-item" role="menuitem" onclick={() => checkout(m)}>
        Checkout{m.checkoutBranch ? ` ${m.checkoutBranch}` : " (detached)"}
      </button>
      <button class="menu-item" role="menuitem" onclick={() => cherryPick(m.commit.oid)}>
        Cherry-pick
      </button>
      <button class="menu-item" role="menuitem" onclick={() => revert(m.commit.oid)}>
        Revert
      </button>
      <div class="menu-sep"></div>
      <button class="menu-item" role="menuitem" onclick={() => merge(m)}>
        Merge into current branch
      </button>
      <button class="menu-item" role="menuitem" onclick={() => rebase(m.commit.oid)}>
        Rebase current branch on this Commit
      </button>
      <!-- Suboptions open a modal, not a cascading submenu (#406). -->
      <button
        class="menu-item"
        role="menuitem"
        onclick={() => openActionModal({ kind: "reset", oid: m.commit.oid, summary: m.commit.summary })}
      >
        Reset current branch to this Commit…
      </button>
      {#if deletableHeads.length > 0 || menuChips.remotes.length > 0}
        <div class="menu-sep"></div>
        {#each deletableHeads as head (head.name)}
          <button
            class="menu-item"
            role="menuitem"
            onclick={() => openActionModal({ kind: "deleteBranch", name: head.name, remotes: head.remotes })}
          >
            Delete Branch '{head.name}'…
          </button>
        {/each}
        {#each menuChips.remotes as remoteChip (remoteChip.name)}
          <button class="menu-item" role="menuitem" onclick={() => deleteRemoteChip(remoteChip)}>
            Delete Remote Branch '{remoteChip.name}'
          </button>
        {/each}
      {/if}
      <div class="menu-sep"></div>
      <button class="menu-item" role="menuitem" onclick={() => copyToClipboard(m.commit.oid, "commit hash")}>
        Copy Commit Hash
      </button>
      <button class="menu-item" role="menuitem" onclick={() => copyToClipboard(m.commit.summary, "commit subject")}>
        Copy Commit Subject
      </button>
    </div>
  {/if}

  {#if prompt}
    <button
      class="menu-backdrop"
      aria-label="Cancel"
      onclick={() => (prompt = null)}
      oncontextmenu={(e) => { e.preventDefault(); prompt = null; }}
    ></button>
    <div class="name-prompt" data-testid="git-graph-prompt" role="dialog" aria-label={prompt.kind === "branch" ? "Create branch" : "Create tag"}>
      <label class="prompt-label" for="git-graph-name-input">
        {prompt.kind === "branch" ? "New branch name" : "New tag name"}
      </label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="git-graph-name-input"
        class="prompt-input"
        type="text"
        autofocus
        bind:value={prompt.value}
        onkeydown={(e) => { if (e.key === "Enter") confirmPrompt(); }}
        placeholder={prompt.kind === "branch" ? "feature/my-branch" : "v1.2.3"}
      />
      <div class="prompt-actions">
        <button class="prompt-btn" onclick={() => (prompt = null)}>Cancel</button>
        <button class="prompt-btn primary" onclick={confirmPrompt}>
          {prompt.kind === "branch" ? "Create branch" : "Create tag"}
        </button>
      </div>
    </div>
  {/if}

  {#if pullOffer}
    <button
      class="menu-backdrop"
      aria-label="Dismiss pull offer"
      onclick={() => (pullOffer = null)}
      oncontextmenu={(e) => { e.preventDefault(); pullOffer = null; }}
    ></button>
    <div class="name-prompt" data-testid="git-graph-pull-offer" role="dialog" aria-label="Pull from upstream">
      <span class="prompt-label">
        The remote is ahead of '{pullOffer.branch}' by {pullOffer.behind}
        commit{pullOffer.behind === 1 ? "" : "s"}. Pull now?
      </span>
      <div class="prompt-actions">
        <button class="prompt-btn" onclick={() => (pullOffer = null)}>Not now</button>
        <button class="prompt-btn primary" onclick={confirmPull}>Pull</button>
      </div>
    </div>
  {/if}

  {#if actionModal}
    <!-- Suboption modal (#406): reset modes / delete-branch variants. -->
    <button
      class="menu-backdrop"
      aria-label="Cancel"
      onclick={() => (actionModal = null)}
      oncontextmenu={(e) => { e.preventDefault(); actionModal = null; }}
    ></button>
    {#if actionModal.kind === "reset"}
      {@const modal = actionModal}
      <div class="name-prompt action-modal" data-testid="git-graph-action-modal" role="dialog" aria-label="Reset current branch">
        <span class="prompt-label">Reset current branch to “{modal.summary}”</span>
        <div class="modal-options">
          <button class="prompt-btn modal-option" onclick={() => confirmModalAction(() => reset(modal.oid, "soft"))}>
            <span class="mo-title">Soft</span><span class="mo-desc">keep changes &amp; index</span>
          </button>
          <button class="prompt-btn modal-option" onclick={() => confirmModalAction(() => reset(modal.oid, "mixed"))}>
            <span class="mo-title">Mixed</span><span class="mo-desc">keep changes, reset index</span>
          </button>
          <button class="prompt-btn modal-option danger" onclick={() => confirmModalAction(() => reset(modal.oid, "hard"))}>
            <span class="mo-title">Hard</span><span class="mo-desc">discard all changes</span>
          </button>
        </div>
        <div class="prompt-actions">
          <button class="prompt-btn" onclick={() => (actionModal = null)}>Cancel</button>
        </div>
      </div>
    {:else}
      {@const modal = actionModal}
      <div class="name-prompt action-modal" data-testid="git-graph-action-modal" role="dialog" aria-label="Delete branch">
        <span class="prompt-label">Delete branch '{modal.name}'</span>
        <div class="modal-options">
          <button class="prompt-btn modal-option" onclick={() => confirmModalAction(() => deleteBranch(modal.name, false, []))}>
            <span class="mo-title">Delete</span><span class="mo-desc">refuse if unmerged</span>
          </button>
          <button class="prompt-btn modal-option danger" onclick={() => confirmModalAction(() => deleteBranch(modal.name, true, []))}>
            <span class="mo-title">Force delete</span><span class="mo-desc">even if unmerged</span>
          </button>
          {#if modal.remotes.length > 0}
            <button class="prompt-btn modal-option danger" onclick={() => confirmModalAction(() => deleteBranch(modal.name, false, modal.remotes))}>
              <span class="mo-title">Delete + remote</span><span class="mo-desc">{modal.remotes.join(", ")}</span>
            </button>
          {/if}
        </div>
        <div class="prompt-actions">
          <button class="prompt-btn" onclick={() => (actionModal = null)}>Cancel</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .git-graph-view {
    flex: 1;
    display: flex;
    flex-direction: column;
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
    color: var(--danger, #ef4444);
  }

  /* Standing detached-HEAD banner (#524). Deliberately louder than the rest of
     the graph chrome (white on a deep red, like the reference tool's permanent
     status treatment): this is a MODE the user must not forget they are in,
     and it is the only element here that outlives every menu. */
  .detached-banner {
    flex-shrink: 0;
    /* Not flex: `text-overflow` needs a block box to elide the label in a
       narrow pane. */
    height: 20px;
    line-height: 20px;
    padding: 0 10px;
    /* Deliberately not themed: a warning that changes contrast per theme is a
       warning that can disappear. This pair is fixed at ~6:1. */
    background: #b3261e;
    color: #fff;
    font-size: var(--font-size-caption);
    font-weight: 700;
    letter-spacing: 0.04em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }

  .commit-row {
    /* Windowed rendering (#256): rows sit at their absolute grid offset so
       the visible slice needs no sibling flow. */
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 14px 0 10px;
    font-size: var(--font-size-body);
    overflow: hidden;
  }

  .commit-row:hover {
    background: var(--subtle-fill-secondary);
  }

  .commit-row {
    cursor: pointer;
  }

  .commit-row.selected {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  /* Subtle tint marking the row the current HEAD points at, à la Git Graph. */
  .commit-row.is-head {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  .commit-row.is-head.selected {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  /* Merge commits are muted (#458): dim only the text spans so the graph
     vertex and lanes (a separate SVG) stay at full strength. Opacity keeps
     this theme-agnostic. */
  .commit-row.is-merge .summary,
  .commit-row.is-merge .author,
  .commit-row.is-merge .date,
  .commit-row.is-merge .oid {
    opacity: 0.5;
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

  .detail-columns {
    display: flex;
    gap: 18px;
    align-items: flex-start;
  }

  /* Left column: commit metadata + message (VSCode layout). */
  .detail-meta-col {
    flex: 0 0 300px;
    min-width: 0;
    max-width: 40%;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .meta-label {
    font-weight: 700;
  }

  .meta-line {
    color: var(--text-secondary);
    word-break: break-all;
  }

  .meta-mono {
    font-family: var(--font-mono, monospace);
  }

  .meta-note {
    color: var(--text-tertiary);
  }

  /* white-space: pre-wrap renders a leading "\n" as a blank line — the
     backend already trims commit.summary at its producers (#464), but
     .trimStart() at the call site is a cheap belt-and-braces guard for any
     value that reaches here without going through them (e.g. optimistic
     UI updates). */
  .detail-message {
    margin: 8px 0 0;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .detail-files-col {
    flex: 1;
    min-width: 0;
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

    .detail-files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .detail-files li {
    display: flex;
    flex-direction: column;
  }

  .detail-file {
    display: flex;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    padding: 2px 4px;
    margin: 0 -4px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    font: inherit;
    text-align: left;
    color: inherit;
    cursor: pointer;
  }

  .detail-file:hover,
  .detail-file.open {
    background: var(--subtle-fill-secondary);
  }

  /* Inline commit panel on the uncommitted node (#466). */
  .commit-box {
    gap: 6px;
  }

  .commit-box-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 44px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: var(--font-size-body);
    color: var(--text-primary);
    background: var(--background-solid);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
  }

  .commit-box-input:focus {
    outline: none;
    border-color: var(--accent, #3b82f6);
  }

  .commit-box-error {
    font-size: var(--font-size-caption);
    color: #ef4444;
  }

  .commit-box-actions {
    display: flex;
    justify-content: flex-end;
  }

  .commit-box-btn {
    padding: 4px 12px;
    font: inherit;
    font-size: var(--font-size-body);
    color: #fff;
    background: var(--accent, #3b82f6);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .commit-box-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .stage-group {
    margin-bottom: 8px;
  }

  .stage-group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .stage-group-count {
    color: var(--text-tertiary);
  }

  .stage-all-btn {
    margin-left: auto;
    padding: 0 6px;
    font: inherit;
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--divider);
    border-radius: 3px;
    cursor: pointer;
    text-transform: none;
    letter-spacing: normal;
  }

  .stage-all-btn:hover {
    background: var(--subtle-fill-secondary);
  }

  .detail-file-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .detail-file-row .detail-file {
    flex: 1;
    min-width: 0;
  }

  .stage-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    color: var(--text-tertiary);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    opacity: 0;
  }

  .detail-file-row:hover .stage-btn,
  .stage-btn:focus-visible {
    opacity: 1;
  }

  .stage-btn:hover {
    color: var(--text-primary);
    background: var(--subtle-fill-secondary);
  }

  /* Per-file inline diff. */
  .file-diff {
    margin: 2px 0 6px 22px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    max-height: 320px;
    overflow: auto;
    background: var(--background-solid);
  }

  .diff-note {
    padding: 6px 10px;
    color: var(--text-tertiary);
  }

  .diff-lines {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-caption);
    line-height: 1.5;
  }

  .diff-line {
    display: flex;
    white-space: pre;
  }

  .diff-line.add { background: color-mix(in srgb, #22c55e 12%, transparent); }
  .diff-line.remove { background: color-mix(in srgb, #ef4444 12%, transparent); }
  .diff-line.hunk { background: var(--subtle-fill-secondary); color: var(--text-tertiary); }

  .diff-gutter {
    flex: none;
    width: 34px;
    padding-right: 6px;
    text-align: right;
    color: var(--text-tertiary);
    user-select: none;
  }

  .diff-sigil {
    flex: none;
    width: 14px;
    text-align: center;
    color: var(--text-tertiary);
    user-select: none;
  }

  .diff-content {
    flex: 1;
    min-width: 0;
  }

  /* Changed-files rows use the regular app font (#499). These declared
     var(--font-mono, monospace), but --font-mono is defined nowhere, so they
     always resolved to the generic monospace family and stood out against the
     rest of the UI. Named explicitly (rather than `inherit` off the enclosing
     `.detail-file { font: inherit }`) so the intent is legible here and a unit
     test can resolve it against the :root token table. The fixed-width status
     column keeps the file names aligned without needing a mono face. */
  .file-status {
    flex: none;
    width: 14px;
    font-weight: 700;
    font-family: var(--font-family);
  }

  .s-A { color: #22c55e; }
  .s-M { color: #d4a017; }
  .s-D { color: #ef4444; }
  .s-R, .s-C { color: #60a5fa; }
  .s-T { color: #a78bfa; }

  /* One line, always (#500). This used to be `word-break: break-all` with
     nothing stopping it wrapping, so a long path reflowed mid-word — two lines
     at a 1280px window, six at 700px — inflating the inline commit panel and
     pushing the graph rows below it down. Every other column in the graph
     truncates instead, so this one does too.

     The path is split into an elidable directory prefix and its final segment
     so the half that identifies the file is the half that survives.

     The priority is expressed with `flex-shrink: 0` + `max-width: 100%` on the
     name rather than by giving the two halves different shrink factors. Shrink
     factors are *proportional*: however lopsided the weights, the name still
     gives up its share of any deficit, so it would ellipsise a couple of pixels
     early while the directory still had room left to yield. `flex-shrink: 0`
     makes the directory absorb the whole deficit before the name loses
     anything, and `max-width: 100%` is what still bounds the name to the row
     when the name alone is wider than the column — there it ellipsises, which
     is the only sane outcome. */
  .file-path {
    display: flex;
    flex: 1;
    min-width: 0;
    font-family: var(--font-family);
    color: var(--text-secondary);
  }

  .file-dir,
  .file-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .file-dir {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--text-tertiary);
  }

  .file-name {
    flex: 0 0 auto;
    max-width: 100%;
  }

  .file-empty {
    color: var(--text-tertiary);
  }

  /* Column header (#341): mirrors the row layout (same left padding and gap)
     so labels align with their columns; hosts the drag handles. */
  .graph-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    flex-shrink: 0;
    padding: 0 14px 0 10px; /* left is overridden inline to clear the lanes */
    border-bottom: 1px solid var(--divider);
    font-size: var(--font-size-caption);
    font-weight: 600;
    color: var(--text-tertiary);
    user-select: none;
  }

  .gh-message {
    flex: 1;
    min-width: 0;
  }

  .gh-author,
  .gh-date {
    position: relative;
    flex-shrink: 0;
    text-align: right;
  }

  .gh-oid {
    flex-shrink: 0;
    width: 60px;
    margin-left: 8px;
    text-align: right;
  }

  /* Parent column (#402): wider — merges list two short OIDs. */
  .gh-parent,
  .parent-col {
    width: 120px;
  }

  .col-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 9px;
    cursor: ew-resize;
    z-index: 2;
  }

  .col-handle::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 5px;
    bottom: 5px;
    width: 1px;
    background: var(--divider);
  }

  .col-handle:hover::after,
  .col-handle.active::after {
    background: var(--accent);
    width: 2px;
  }

  /* Author/date handles sit on the cell's left edge, in the flex gap. */
  .handle-in-cell {
    left: -9px;
  }

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
    color: var(--accent);
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
    color: var(--accent);
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

  .graph-scroller {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  /* Clip window for the lane SVG (#341): same origin the underlay used to
     have; hides lanes beyond the (possibly user-narrowed) graph column. */
  .graph-clip {
    position: absolute;
    top: 0;
    left: 10px;
    height: 100%;
    overflow: hidden;
    pointer-events: none;
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

  .graph-underlay {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
  }

  /* Subtle halo under each line so crossings stay legible (reference uses a
     shadow path beneath every line). */
  .branch-halo {
    stroke: var(--background-card);
    stroke-width: 4px;
    fill: none;
  }

  .uncommitted-label {
    color: var(--text-tertiary);
    font-style: italic;
  }

  .ref-active {
    outline: 1px solid var(--accent);
  }

  .ref-remote-sub {
    margin-left: 4px;
    padding: 0 4px;
    border-radius: 6px;
    background: color-mix(in srgb, #3b82f6 18%, transparent);
    color: #3b82f6;
    font-size: var(--font-size-caption);
  }

  .ref-stash {
    background: color-mix(in srgb, #64748b 18%, transparent);
    color: #64748b;
    border-color: color-mix(in srgb, #64748b 40%, transparent);
    font-family: var(--font-mono, monospace);
  }

  .oid {
    font-family: var(--font-mono, monospace);
    color: var(--text-tertiary);
    flex-shrink: 0;
    margin-left: 8px;
    font-variant-numeric: tabular-nums;
    /* Fixed so the header's "Commit" label stays aligned (#341). */
    width: 60px;
    text-align: right;
    overflow: hidden;
  }

  .ref {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: var(--font-size-caption);
    font-weight: 600;
    line-height: 1.5;
    border: 1px solid transparent;
  }

  .ref-head {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent);
    border-color: var(--accent);
  }

  .ref-branch {
    background: color-mix(in srgb, #10b981 15%, transparent);
    color: #10b981;
    border-color: color-mix(in srgb, #10b981 40%, transparent);
  }

  /* Remote-only branch (no local branch tracks it, #381): dashed outline +
     cloud glyph distinguish it from a local branch chip at a glance. */
  .ref-remote {
    background: color-mix(in srgb, #3b82f6 15%, transparent);
    color: #3b82f6;
    border-color: color-mix(in srgb, #3b82f6 40%, transparent);
    border-style: dashed;
  }

  .remote-cloud {
    margin-right: 3px;
    vertical-align: -1px;
  }

  .ref-tag {
    background: color-mix(in srgb, #f59e0b 15%, transparent);
    color: #d97706;
    border-color: color-mix(in srgb, #f59e0b 40%, transparent);
  }

  /* Open GitHub PR badge (#448): GitHub's PR purple. A <button>, not a
     <span> like its neighbours — reset its chrome so it still reads as a
     pill chip. */
  .ref-pr {
    font: inherit;
    cursor: pointer;
    background: color-mix(in srgb, #a371f7 15%, transparent);
    color: #a371f7;
    border-color: color-mix(in srgb, #a371f7 30%, transparent);
  }

  .ref-pr:hover {
    background: color-mix(in srgb, #a371f7 25%, transparent);
  }

  /* Draft PR: desaturated grey, mirroring .ref-remote's dashed-outline
     "not fully real yet" treatment. */
  .ref-pr.draft {
    background: color-mix(in srgb, #8b949e 15%, transparent);
    color: #8b949e;
    border-color: color-mix(in srgb, #8b949e 30%, transparent);
  }

  .ref-pr.draft:hover {
    background: color-mix(in srgb, #8b949e 25%, transparent);
  }

  /* CI-status badge colors (#459): the badge text/tint reflects the head
     commit's check rollup. Draft styling (grey) always wins — a draft never
     gets a ci-* class (see prBadgePresentation). Colors come from the theme's
     system tokens so every theme stays coherent. */
  .ref-pr.ci-success {
    color: var(--system-success);
    background: color-mix(in srgb, var(--system-success) 14%, transparent);
    border-color: color-mix(in srgb, var(--system-success) 32%, transparent);
  }
  .ref-pr.ci-success:hover {
    background: color-mix(in srgb, var(--system-success) 24%, transparent);
  }
  .ref-pr.ci-failure {
    color: var(--system-critical);
    background: color-mix(in srgb, var(--system-critical) 14%, transparent);
    border-color: color-mix(in srgb, var(--system-critical) 32%, transparent);
  }
  .ref-pr.ci-failure:hover {
    background: color-mix(in srgb, var(--system-critical) 24%, transparent);
  }
  .ref-pr.ci-pending {
    color: var(--system-caution);
    background: color-mix(in srgb, var(--system-caution) 14%, transparent);
    border-color: color-mix(in srgb, var(--system-caution) 32%, transparent);
  }
  .ref-pr.ci-pending:hover {
    background: color-mix(in srgb, var(--system-caution) 24%, transparent);
  }

  /* Open dropdown: a subtle ring so the toggled badge reads as active. */
  .ref-pr.open {
    outline: 1px solid currentColor;
    outline-offset: 1px;
  }

  /* Review / comment glyphs appended inside the badge — inherit the badge's
     CI color (currentColor) so the whole chip stays one visual unit. */
  .pr-review,
  .pr-comments {
    margin-left: 3px;
    font-weight: 700;
  }

  /* ----- In-app PR details dropdown (#459) ----- */
  .pr-detail-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-body);
    padding-right: 20px; /* clear the close button */
  }
  .pr-detail-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pr-detail-number {
    font-weight: 700;
    color: #a371f7;
  }
  .pr-detail-title {
    font-weight: 600;
    color: var(--text-primary);
  }
  .pr-detail-chip {
    font-size: var(--font-size-caption);
    font-weight: 600;
    padding: 0 5px;
    border-radius: 6px;
    line-height: 1.5;
  }
  .pr-detail-chip.draft {
    color: #8b949e;
    background: color-mix(in srgb, #8b949e 15%, transparent);
    border: 1px solid color-mix(in srgb, #8b949e 30%, transparent);
  }
  .pr-detail-line {
    color: var(--text-secondary);
  }
  .pr-detail-label {
    color: var(--text-tertiary);
    margin-right: 2px;
  }
  .pr-detail-ci.ci-success {
    color: var(--system-success);
    font-weight: 600;
  }
  .pr-detail-ci.ci-failure {
    color: var(--system-critical);
    font-weight: 600;
  }
  .pr-detail-ci.ci-pending {
    color: var(--system-caution);
    font-weight: 600;
  }
  .pr-detail-open {
    /* Pushed to the right of the title on the head row (#468). */
    margin-left: auto;
    flex-shrink: 0;
    font: inherit;
    font-size: var(--font-size-caption);
    font-weight: 600;
    cursor: pointer;
    color: #a371f7;
    background: color-mix(in srgb, #a371f7 12%, transparent);
    border: 1px solid color-mix(in srgb, #a371f7 30%, transparent);
    border-radius: 6px;
    padding: 3px 10px;
  }
  .pr-detail-open:hover {
    background: color-mix(in srgb, #a371f7 22%, transparent);
  }

  /* ----- PR description + comments (#468) ----- */
  .pr-detail-description {
    margin: 2px 0;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    /* Long descriptions scroll rather than pushing the row expansion huge. */
    max-height: 140px;
    overflow-y: auto;
    line-height: 1.4;
  }
  .pr-detail-comments {
    list-style: none;
    margin: 2px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 220px;
    overflow-y: auto;
  }
  .pr-detail-comment {
    border-left: 2px solid color-mix(in srgb, #a371f7 40%, transparent);
    padding-left: 8px;
  }
  .pr-detail-comment-meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 2px;
  }
  .pr-detail-comment-author {
    font-weight: 600;
    color: var(--text-primary);
  }
  .pr-detail-comment-time {
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
  }
  .pr-detail-comment-body {
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
  }

  .summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .author {
    margin-left: auto;
    flex-shrink: 0;
    width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    color: var(--text-tertiary);
  }

  .date {
    flex-shrink: 0;
    width: 84px;
    text-align: right;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  /* ----- Commit context menu ----- */

  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }

  .commit-menu {
    position: fixed;
    z-index: 41;
    min-width: 232px;
    padding: 4px;
    /* --background-card is translucent in every theme — composite it over
       the solid background so the menu is opaque (#263, same as #243). */
    background: linear-gradient(var(--background-card, #1e1e1e), var(--background-card, #1e1e1e)), var(--background-solid, #1e1e1e);
    border: 1px solid var(--divider);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    font-size: var(--font-size-body);
    display: flex;
    flex-direction: column;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 10px;
    background: none;
    border: none;
    border-radius: 5px;
    color: var(--text-primary);
    font-size: var(--font-size-body);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .menu-item:hover {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .menu-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--divider);
  }

  /* Fixed-width tick gutter so column labels stay aligned (#372). */
  .col-check {
    display: inline-block;
    width: 12px;
    color: var(--accent);
  }

  /* Suboption modal (#406): stacked option buttons inside the name-prompt
     dialog shell. */
  .modal-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0;
  }

  .modal-option {
    display: flex;
    align-items: baseline;
    gap: 8px;
    text-align: left;
    justify-content: flex-start;
  }

  .modal-option.danger .mo-title {
    color: var(--error, #e5534b);
  }

  .mo-title {
    font-weight: 600;
  }

  .mo-desc {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
  }

  /* ----- Name prompt popover (create branch / tag) ----- */

  .name-prompt {
    position: fixed;
    z-index: 42;
    left: 50%;
    top: 30%;
    transform: translateX(-50%);
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 14px 16px;
    background: linear-gradient(var(--background-card, #1e1e1e), var(--background-card, #1e1e1e)), var(--background-solid, #1e1e1e);
    border: 1px solid var(--divider);
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .prompt-label {
    font-size: var(--font-size-body);
    color: var(--text-secondary);
  }

  .prompt-input {
    width: 100%;
    padding: 6px 8px;
    background: var(--background-input, var(--background-card));
    border: 1px solid var(--divider);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: var(--font-size-body);
    font-family: var(--font-mono, monospace);
  }

  .prompt-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
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

  .prompt-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
