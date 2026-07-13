<!--
  GitGraphView — commit-graph pane content for a git-graph tab (#51/#58).
  Renders the repo's history (git_log backend, #57) as a virtualized list of
  rows: an SVG graph cell (lane dot + edge segments from domain/git-graph),
  refs decoration chips, summary, author and date. Pages in more commits as
  the list nears its end.
-->
<script lang="ts" module>
  import { gitLog, type CommitInfo as CachedCommitInfo, type RefInfo as CachedRefInfo } from "$lib/api/git-log";
  import { gitSummary } from "$lib/api/files";

  const PAGE_SIZE = 300;

  /**
   * Per-repo snapshot of the loaded graph, kept across tab switches (#255):
   * PaneContainer recreates GitGraphView on every activation, and without
   * this the view re-runs gitLog+gitSummary IPC and re-renders from scratch —
   * a visible lag. A remount paints synchronously from the snapshot, then
   * refreshes in the background.
   */
  interface GraphSnapshot {
    commits: CachedCommitInfo[];
    refs: Record<string, CachedRefInfo[]>;
    hasMore: boolean;
    headOid: string | null;
    workingChanges: number;
  }

  const graphCache = new Map<string, GraphSnapshot>();
  const GRAPH_CACHE_MAX = 8;

  function cacheSnapshot(repoPath: string, snapshot: GraphSnapshot): void {
    graphCache.delete(repoPath); // re-insert to refresh LRU position
    graphCache.set(repoPath, snapshot);
    if (graphCache.size > GRAPH_CACHE_MAX) {
      const oldest = graphCache.keys().next().value;
      if (oldest !== undefined) graphCache.delete(oldest);
    }
  }

  /** Fetch the page-0 data (first PAGE_SIZE commits + working summary) shared
   *  by the view's own initial load and the background warm (#287). Pass a
   *  branch subset to fetch a filtered page (#342) — never cached.
   *
   *  The log walk and the working-tree summary run CONCURRENTLY, and
   *  `onLog` (when given) fires as soon as the log half is ready: the
   *  status scan can take seconds on a large working tree but only feeds
   *  the "Uncommitted Changes (N)" row, so the graph must not wait for it
   *  (#367 — graph startup was gated on log *then* status, serially). */
  async function fetchPage0Snapshot(
    repoPath: string,
    branches: string[] | null = null,
    onLog?: (partial: Omit<GraphSnapshot, "workingChanges">) => void,
  ): Promise<GraphSnapshot> {
    const summaryPromise = gitSummary(repoPath);
    const page = await gitLog(repoPath, {
      skip: 0,
      limit: PAGE_SIZE,
      ...(branches ? { branches } : {}),
    });
    const headOid =
      Object.entries(page.refs).find(([, rs]) => rs.some((r) => r.kind === "Head"))?.[0] ?? null;
    const partial = {
      commits: page.commits.slice(0, PAGE_SIZE),
      refs: page.refs,
      hasMore: page.has_more,
      headOid,
    };
    onLog?.(partial);
    const summary = await summaryPromise;
    const workingChanges = summary.ok
      ? summary.data.staged.length +
        summary.data.changes.length +
        summary.data.untracked.length +
        summary.data.merge.length
      : 0;
    return { ...partial, workingChanges };
  }

  const warmInFlight = new Set<string>();

  /**
   * Best-effort background warm (#287): populate graphCache for a repo before
   * its git-graph tab is ever opened, so the first open paints instantly from
   * cache instead of showing "Loading history…". No-op if already cached or a
   * warm for the same repo is already in flight; failures are swallowed (the
   * view still loads normally when actually opened).
   */
  export async function warmGraphSnapshot(repoPath: string): Promise<void> {
    if (!repoPath || graphCache.has(repoPath) || warmInFlight.has(repoPath)) return;
    warmInFlight.add(repoPath);
    try {
      cacheSnapshot(repoPath, await fetchPage0Snapshot(repoPath));
    } catch {
      /* best-effort warm — ignore failures */
    } finally {
      warmInFlight.delete(repoPath);
    }
  }
</script>

<script lang="ts">
  import {
    gitCommitFiles,
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
    gitDeleteBranch,
    gitDeleteRemoteBranch,
    type CommitInfo,
    type RefInfo,
    type CommitFile,
    type ResetMode,
  } from "$lib/api/git-log";
  import { assignLayout, branchPath, groupRefChips, sliceBranchLine, GRAPH_PALETTE, type GraphLayout, type BranchLine, type RefChips } from "$lib/domain/git-graph";
  import { clientToFixed } from "$lib/domain/zoom";
  import { parseUnifiedDiff, type ParsedDiff } from "$lib/domain/diff";
  import { highlightDiffLine } from "$lib/domain/syntax-highlight";
  import { gitStatusLetter } from "$lib/domain/git";
  import { notifyLocalGitChange, subscribeGitChanges } from "$lib/state/git-refresh";
  import { gitWatchRepo, gitUnwatchRepo } from "$lib/api/git";
  import { directoryKey } from "$lib/domain/path";
  import { toastStore } from "$lib/state/toast.svelte";
  import { gitDiff } from "$lib/api/files";
  import { untrack } from "svelte";
  import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";
  import { loadPersisted, savePersisted } from "$lib/state/persisted";

  const { repoPath }: { repoPath: string } = $props();

  const ROW_HEIGHT = 28;
  const LANE_WIDTH = 14;
  // PAGE_SIZE lives in the module script (shared with warmGraphSnapshot).
  const UNCOMMITTED = "*";

  let commits = $state<CommitInfo[]>([]);
  let refs = $state<Record<string, RefInfo[]>>({});
  let hasMore = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let selected = $state<CommitInfo | null>(null);
  /** File rows in the expanded details. `staged` is set only for the
   *  synthetic uncommitted row, where it picks the right working-tree diff. */
  interface DetailFile extends CommitFile {
    staged?: boolean;
  }
  let selectedFiles = $state<DetailFile[]>([]);
  /** Working-tree change count → synthetic top row (reference behavior). */
  let workingChanges = $state(0);
  let headOid = $state<string | null>(null);

  // Branch subset filter (#342): null = all branches. Persisted per repo so a
  // curated view (e.g. just dev + main) survives reopening the graph.
  const BRANCH_FILTER_KEY = `git-graph-branch-filter:${untrack(() => repoPath)}`;
  const savedBranchFilter = loadPersisted<unknown>(BRANCH_FILTER_KEY, null);
  let branchFilter = $state<string[] | null>(
    Array.isArray(savedBranchFilter) &&
      savedBranchFilter.length > 0 &&
      savedBranchFilter.every((s) => typeof s === "string")
      ? (savedBranchFilter as string[])
      : null,
  );

  // Paint the last-known graph immediately on remount (#255); the load
  // effect below still refreshes from git in the background. Skipped while a
  // branch filter is active — the warm cache is always the UNFILTERED page 0,
  // and flashing it would briefly show branches the user hid (#342).
  if (untrack(() => branchFilter) === null) {
    // untrack: the view is {#key}ed on repoPath, so the initial value is the
    // right one for this instance's lifetime.
    const cached = graphCache.get(untrack(() => repoPath));
    if (cached) {
      commits = cached.commits;
      refs = cached.refs;
      hasMore = cached.hasMore;
      headOid = cached.headOid;
      workingChanges = cached.workingChanges;
    }
  }

  // Inline per-file diff (#221, VSCode Git Graph parity): one open at a time.
  let openDiffPath = $state<string | null>(null);
  let openDiff = $state<ParsedDiff | null>(null);
  let diffLoading = $state(false);
  // Measured height of the inline details block; stretches the graph SVG so
  // rows below the expansion stay aligned with their vertices.
  let detailsHeight = $state(0);

  function closeDetails(): void {
    selected = null;
    selectedFiles = [];
    openDiffPath = null;
    openDiff = null;
    detailsHeight = 0;
  }

  async function selectCommit(commit: CommitInfo): Promise<void> {
    if (selected?.oid === commit.oid) {
      closeDetails();
      return;
    }
    closeDetails();
    selected = commit;
    try {
      if (commit.oid === UNCOMMITTED) {
        // Working-tree changes: flatten the SCM summary buckets, remembering
        // which side of the index each file sits on for the diff below.
        const res = await gitSummary(repoPath);
        if (!res.ok) throw new Error(res.error);
        const buckets: Array<[{ path: string; status: string }[], boolean]> = [
          [res.data.staged, true],
          [res.data.changes, false],
          [res.data.merge, false],
          [res.data.untracked, false],
        ];
        selectedFiles = buckets.flatMap(([files, staged]) =>
          files.map((f) => ({ path: f.path, status: gitStatusLetter(f.status), staged })),
        );
      } else {
        selectedFiles = await gitCommitFiles(repoPath, commit.oid);
      }
    } catch {
      selectedFiles = [];
    }
  }

  /** Expand/collapse one file's diff below its row. */
  async function toggleFileDiff(file: DetailFile): Promise<void> {
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

  /** Rows fed to layout/render: a synthetic uncommitted-changes row on top
   *  (when the working tree is dirty and HEAD is loaded), then the page. */
  const displayCommits: CommitInfo[] = $derived(
    workingChanges > 0 && headOid
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
  const layout: GraphLayout = $derived(assignLayout(displayCommits));
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
  type ColumnId = "author" | "date" | "commit";
  const savedColumns = loadPersisted<unknown>(COLUMNS_KEY, null);
  let shownColumns = $state<Record<ColumnId, boolean>>({
    author: true,
    date: true,
    commit: true,
    ...(typeof savedColumns === "object" && savedColumns !== null ? savedColumns : {}),
  });
  let columnMenu = $state<{ x: number; y: number } | null>(null);

  function toggleColumn(id: ColumnId): void {
    shownColumns = { ...shownColumns, [id]: !shownColumns[id] };
    savePersisted(COLUMNS_KEY, shownColumns);
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
  /** Row index of the expanded (selected) commit, or -1. */
  const expandedIndex = $derived(
    selected ? displayCommits.findIndex((c) => c.oid === selected!.oid) : -1,
  );
  /** SVG stretch below the inline details block (see domain RowExpand). */
  const rowExpand = $derived(
    expandedIndex >= 0 && detailsHeight > 0
      ? // +6: the block's bottom gap (its margin-bottom is outside offsetHeight).
        { afterRow: expandedIndex, extra: detailsHeight + 6 }
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

  async function loadPage(skip: number): Promise<void> {
    // Captured once so a mid-flight filter change can't mix pages; filtered
    // loads never touch the snapshot cache (it holds the unfiltered page 0).
    const filter = untrack(() => branchFilter);
    loading = true;
    error = null;
    try {
      if (skip === 0) {
        // Same page-0 fetch used by the background warm (#287), so an open
        // that follows a warm reuses identical data. The commit list paints
        // as soon as the log arrives; the working-changes count (a full
        // status scan, slow on big working trees) fills in after (#367).
        const snapshot = await fetchPage0Snapshot(repoPath, filter, (partial) => {
          commits = partial.commits;
          refs = partial.refs;
          hasMore = partial.hasMore;
          headOid = partial.headOid;
          loading = false;
        });
        workingChanges = snapshot.workingChanges;
        if (filter === null) cacheSnapshot(repoPath, snapshot);
      } else {
        const page = await gitLog(repoPath, {
          skip,
          limit: PAGE_SIZE,
          ...(filter ? { branches: filter } : {}),
        });
        commits = [...commits, ...page.commits];
        refs = { ...refs, ...page.refs };
        hasMore = page.has_more;
        // Snapshot page 0 for instant remount paint (#255) — deliberately not
        // the full paged history, which can grow unbounded.
        if (filter === null) {
          cacheSnapshot(repoPath, {
            commits: commits.slice(0, PAGE_SIZE),
            refs,
            hasMore: hasMore || commits.length > PAGE_SIZE,
            headOid,
            workingChanges,
          });
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Genuine side effect (IPC) keyed on the repo this tab shows and the
  // active branch filter; loadPage reads the filter via untrack, so the
  // explicit reads here are the only dependencies.
  $effect(() => {
    void repoPath;
    void branchFilter;
    untrack(() => void loadPage(0));
  });

  // Live refresh (#365): watch the repo and reload page 0 when git state
  // changes underneath us (pull/commit/checkout from the terminal, another
  // window, or the SCM panel). Watcher events are coalesced backend-side;
  // a short debounce here folds the watcher burst a pull produces into one
  // reload, and reloads are skipped while a load is already in flight.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const repo = repoPath;
    let disposed = false;
    let unsub: (() => void) | undefined;
    void gitWatchRepo(repo);
    void subscribeGitChanges((change) => {
      if (change.repoRoot && directoryKey(change.repoRoot) !== directoryKey(repo)) return;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (!disposed && !untrack(() => loading)) void loadPage(0);
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
    };
  });

  // ----- Branch filter popover (#342) -----

  let branchPopoverOpen = $state(false);
  let branchQuery = $state("");
  let branchList = $state<Array<{ name: string; remote: boolean }>>([]);

  async function toggleBranchPopover(): Promise<void> {
    branchPopoverOpen = !branchPopoverOpen;
    if (branchPopoverOpen && branchList.length === 0) {
      try {
        const r = await gitRefs(repoPath);
        branchList = [
          ...r.local_branches.map((b) => ({ name: b.name, remote: false })),
          ...r.remote_branches.map((b) => ({ name: b.name, remote: true })),
        ];
      } catch {
        branchList = [];
      }
    }
  }

  const filteredBranchList = $derived(
    branchList.filter((b) => b.name.toLowerCase().includes(branchQuery.toLowerCase())),
  );

  function setBranchFilter(next: string[] | null): void {
    branchFilter = next && next.length > 0 ? next : null;
    savePersisted(BRANCH_FILTER_KEY, branchFilter);
    // The selected commit may not exist in the new subset.
    closeDetails();
  }

  function isBranchShown(name: string): boolean {
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

  // One shared formatter: constructing Intl state per row per render is a
  // measurable cost at hundreds of rows (#256).
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  function formatDate(unixSeconds: number): string {
    return dateFormatter.format(new Date(unixSeconds * 1000));
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
      if (!loading && hasMore) void loadPage(commits.length);
    }
  }

  /** Combined ref chips — grouping math lives in domain/git-graph.ts. */
  function chipsFor(oid: string): RefChips {
    return groupRefChips(refs[oid] ?? []);
  }

  // ----- Commit context menu (VSCode "Git Graph"-parity actions) -----

  interface Menu {
    x: number;
    y: number;
    commit: CommitInfo;
    /** Branch to attach on Checkout, or null → detached checkout of the OID. */
    checkoutBranch: string | null;
  }
  let menu = $state<Menu | null>(null);
  // Inline name prompt for Create Branch / Create Tag.
  let prompt = $state<{ kind: "branch" | "tag"; oid: string; value: string } | null>(null);

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

  function openMenu(event: MouseEvent, commit: CommitInfo): void {
    event.preventDefault();
    prompt = null;
    // clientToFixed: the menu is position:fixed, so cursor coordinates must be
    // converted into fixed-CSS space or the menu drifts under CSS zoom (same
    // transform ContextMenu uses — see domain/zoom.ts).
    menu = {
      x: clientToFixed(event.clientX),
      y: clientToFixed(event.clientY),
      commit,
      checkoutBranch: localBranchAt(commit.oid),
    };
  }

  function closeMenu(): void {
    menu = null;
    prompt = null;
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
      await loadPage(0);
      notifyLocalGitChange(repoPath);
    }
  }

  function checkout(m: Menu): void {
    void runAction("Checkout", () =>
      gitCheckout(repoPath, m.checkoutBranch ?? m.commit.oid),
    );
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
  function deleteRemoteChip(chip: string): void {
    const i = chip.indexOf("/");
    if (i <= 0) return;
    void runAction(`Delete ${chip}`, () =>
      gitDeleteRemoteBranch(repoPath, chip.slice(0, i), chip.slice(i + 1)),
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
  let fetching = $state(false);
  async function refreshWithFetch(): Promise<void> {
    if (fetching) return;
    fetching = true;
    try {
      await gitFetch(repoPath);
      toastStore.success("Fetched from remotes");
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : String(err));
    } finally {
      fetching = false;
      await loadPage(0);
      notifyLocalGitChange(repoPath);
    }
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "F5") {
      event.preventDefault();
      void refreshWithFetch();
      return;
    }
    if (event.key === "Escape" && branchPopoverOpen) {
      branchPopoverOpen = false;
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
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- right-click opens the column-visibility menu; not reachable by keyboard by design (parity with the row context menu) -->
    <div class="graph-header" role="row" tabindex="-1" style:padding-left="{effectiveGraphWidth + 20}px" oncontextmenu={openColumnMenu}>
      <button
        class="branch-filter-btn"
        class:filtered={branchFilter !== null}
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
          <!-- svelte-ignore a11y_autofocus -- opened by explicit user action; focus goes where they're about to type -->
          <input
            class="bf-search"
            placeholder="Filter branches…"
            bind:value={branchQuery}
            autofocus
          />
          <div class="bf-list">
            <button
              class="bf-row bf-all"
              class:bf-active={branchFilter === null}
              onclick={() => setBranchFilter(null)}
            >
              All branches
            </button>
            {#each filteredBranchList as b (b.name)}
              <label class="bf-row" title="Show or hide {b.name}">
                <input
                  type="checkbox"
                  checked={isBranchShown(b.name)}
                  onchange={() => toggleBranch(b.name)}
                />
                <span class="bf-name">{b.name}</span>
                {#if b.remote}<span class="bf-remote">remote</span>{/if}
                <button
                  class="bf-only"
                  title="Show only {b.name}"
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
      <span class="gh-message">Message</span>
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
        {#each [["author", "Author"], ["date", "Date"], ["commit", "Commit"]] as [id, label] (id)}
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
      </div>
    {/if}
    {#if commits.length === 0 && loading}
      <div class="graph-status">Loading history…</div>
    {:else if commits.length === 0}
      <div class="graph-status">No commits.</div>
    {:else}
    <div class="graph-scroller" onscroll={handleScroll} bind:clientHeight={viewportHeight}>
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

        {#each visibleRows as { commit, index } (commit.oid)}
          {@const chips = chipsFor(commit.oid)}
          {@const synthetic = commit.oid === UNCOMMITTED}
          <div
            class="commit-row"
            class:selected={selected?.oid === commit.oid}
            class:is-head={chips.isHead}
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
              {#each chips.heads as head (head.name)}
                <span class="ref ref-branch" class:ref-active={head.active}>
                  {head.name}
                  {#each head.remotes as remote (remote)}
                    <span class="ref-remote-sub" title="{remote}/{head.name} is at this commit">{remote}</span>
                  {/each}
                </span>
              {/each}
              {#each chips.remotes as remote (remote)}
                <span class="ref ref-remote">{remote}</span>
              {/each}
              {#each chips.tags as tag (tag)}
                <span class="ref ref-tag">{tag}</span>
              {/each}
              <span class="summary" title={commit.summary}>{commit.summary}</span>
              {#if shownColumns.author}<span class="author" style:width="{authorCol.width}px">{commit.author_name}</span>{/if}
              {#if shownColumns.date}<span class="date" style:width="{dateCol.width}px">{formatDate(commit.author_time)}</span>{/if}
              {#if shownColumns.commit}<span class="oid">{commit.short_oid}</span>{/if}
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
                    <div class="meta-line"><span class="meta-label">Commit:</span> <span class="meta-mono">{commit.oid}</span></div>
                    <div class="meta-line"><span class="meta-label">Parents:</span> <span class="meta-mono">{commit.parents.map((p) => p.slice(0, 8)).join(", ") || "—"}</span>{#if commit.parents.length > 1} <span class="meta-note">(merge of {commit.parents.length} parents)</span>{/if}</div>
                    <div class="meta-line"><span class="meta-label">Author:</span> {commit.author_name} &lt;{commit.author_email}&gt;</div>
                    <div class="meta-line"><span class="meta-label">Date:</span> {formatDate(commit.author_time)}</div>
                    <p class="detail-message">{commit.summary}</p>
                  </div>
                {:else}
                  <div class="detail-meta-col">
                    <p class="detail-message">{commit.summary}</p>
                  </div>
                {/if}
                <div class="detail-files-col">
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
                      <span class="file-path">{file.path}</span>
                      {#if file.staged}<span class="file-staged-badge">staged</span>{/if}
                    </button>
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
                  </li>
                {:else}
                  <li class="file-empty">No file changes (or still loading…)</li>
                {/each}
              </ul>
                </div>
              </div>
            </div>
          {/if}
        {/each}
      </div>
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
    {@const deletableHeads = menuChips.heads.filter((h) => !h.active)}
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
      <div class="menu-item has-submenu" role="menuitem" tabindex="-1">
        <span>Reset current branch to this Commit</span>
        <span class="submenu-arrow">▸</span>
        <div class="submenu" role="menu">
          <button class="menu-item" role="menuitem" onclick={() => reset(m.commit.oid, "soft")}>
            Soft — keep changes & index
          </button>
          <button class="menu-item" role="menuitem" onclick={() => reset(m.commit.oid, "mixed")}>
            Mixed — keep changes, reset index
          </button>
          <button class="menu-item" role="menuitem" onclick={() => reset(m.commit.oid, "hard")}>
            Hard — discard all changes
          </button>
        </div>
      </div>
      {#if deletableHeads.length > 0 || menuChips.remotes.length > 0}
        <div class="menu-sep"></div>
        {#each deletableHeads as head (head.name)}
          <div class="menu-item has-submenu" role="menuitem" tabindex="-1">
            <span>Delete Branch '{head.name}'</span>
            <span class="submenu-arrow">▸</span>
            <div class="submenu" role="menu">
              <button class="menu-item" role="menuitem" onclick={() => deleteBranch(head.name, false, [])}>
                Delete — refuse if unmerged
              </button>
              <button class="menu-item" role="menuitem" onclick={() => deleteBranch(head.name, true, [])}>
                Force delete
              </button>
              {#if head.remotes.length > 0}
                <button class="menu-item" role="menuitem" onclick={() => deleteBranch(head.name, false, head.remotes)}>
                  Delete + remote ({head.remotes.join(", ")})
                </button>
              {/if}
            </div>
          </div>
        {/each}
        {#each menuChips.remotes as remoteChip (remoteChip)}
          <button class="menu-item" role="menuitem" onclick={() => deleteRemoteChip(remoteChip)}>
            Delete Remote Branch '{remoteChip}'
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
</div>

<style>
  .git-graph-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--background-card);
    color: var(--text-primary);
  }

  .graph-status {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .graph-status.error {
    color: var(--danger, #ef4444);
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
    font-size: 12px;
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
    font-size: 12px;
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
    font-size: 11px;
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

  .file-staged-badge {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-tertiary);
    border: 1px solid var(--divider);
    border-radius: 3px;
    padding: 0 4px;
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
    font-size: 11px;
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

  .file-status {
    width: 14px;
    font-weight: 700;
    font-family: var(--font-mono, monospace);
  }

  .s-A { color: #22c55e; }
  .s-M { color: #d4a017; }
  .s-D { color: #ef4444; }
  .s-R, .s-C { color: #60a5fa; }
  .s-T { color: #a78bfa; }

  .file-path {
    font-family: var(--font-mono, monospace);
    color: var(--text-secondary);
    word-break: break-all;
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
    font-size: 11px;
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
    font-size: 10px;
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

  .bf-search {
    margin: 6px;
    padding: 4px 8px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--background-card);
    color: var(--text-primary);
    font-size: 12px;
  }

  .bf-list {
    overflow-y: auto;
    padding: 0 4px 6px;
  }

  .bf-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
  }

  .bf-row:hover {
    background: var(--subtle-fill-secondary);
  }

  button.bf-row {
    background: none;
    border: none;
    text-align: left;
    font: inherit;
  }

  .bf-all.bf-active {
    color: var(--accent);
    font-weight: 600;
  }

  .bf-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bf-remote {
    font-size: 10px;
    color: var(--text-tertiary);
    border: 1px solid var(--divider);
    border-radius: 3px;
    padding: 0 3px;
  }

  .bf-only {
    visibility: hidden;
    background: none;
    border: none;
    font-size: 10px;
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
    font-size: 12px;
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
    font-size: 9px;
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
    font-size: 10px;
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

  .ref-remote {
    background: color-mix(in srgb, #3b82f6 15%, transparent);
    color: #3b82f6;
    border-color: color-mix(in srgb, #3b82f6 40%, transparent);
  }

  .ref-tag {
    background: color-mix(in srgb, #f59e0b 15%, transparent);
    color: #d97706;
    border-color: color-mix(in srgb, #f59e0b 40%, transparent);
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
    font-size: 12px;
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
    font-size: 12px;
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

  .has-submenu {
    position: relative;
    justify-content: space-between;
    cursor: default;
  }

  .submenu-arrow {
    color: var(--text-tertiary);
    font-size: 10px;
  }

  .submenu {
    position: absolute;
    left: 100%;
    top: -4px;
    min-width: 220px;
    padding: 4px;
    background: linear-gradient(var(--background-card, #1e1e1e), var(--background-card, #1e1e1e)), var(--background-solid, #1e1e1e);
    border: 1px solid var(--divider);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    display: none;
    flex-direction: column;
  }

  .has-submenu:hover .submenu,
  .has-submenu:focus-within .submenu {
    display: flex;
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
    font-size: 12px;
    color: var(--text-secondary);
  }

  .prompt-input {
    width: 100%;
    padding: 6px 8px;
    background: var(--background-input, var(--background-card));
    border: 1px solid var(--divider);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
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
    font-size: 12px;
    cursor: pointer;
  }

  .prompt-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
