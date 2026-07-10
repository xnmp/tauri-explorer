<!--
  GitGraphView — commit-graph pane content for a git-graph tab (#51/#58).
  Renders the repo's history (git_log backend, #57) as a virtualized list of
  rows: an SVG graph cell (lane dot + edge segments from domain/git-graph),
  refs decoration chips, summary, author and date. Pages in more commits as
  the list nears its end.
-->
<script lang="ts">
  import {
    gitLog,
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
    type CommitInfo,
    type RefInfo,
    type CommitFile,
    type ResetMode,
  } from "$lib/api/git-log";
  import { assignLayout, branchPath, groupRefChips, GRAPH_PALETTE, type GraphLayout, type BranchLine, type RefChips } from "$lib/domain/git-graph";
  import { clientToFixed } from "$lib/domain/zoom";
  import { parseUnifiedDiff, type ParsedDiff } from "$lib/domain/diff";
  import { highlightDiffLine } from "$lib/domain/syntax-highlight";
  import { gitStatusLetter } from "$lib/domain/git";
  import { notifyLocalGitChange } from "$lib/state/git-refresh";
  import { toastStore } from "$lib/state/toast.svelte";
  import { gitDiff, gitSummary } from "$lib/api/files";

  const { repoPath }: { repoPath: string } = $props();

  const ROW_HEIGHT = 28;
  const LANE_WIDTH = 14;
  const PAGE_SIZE = 300;
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
  /** Row index of the expanded (selected) commit, or -1. */
  const expandedIndex = $derived(
    selected ? displayCommits.findIndex((c) => c.oid === selected!.oid) : -1,
  );
  /** SVG stretch below the inline details block (see domain RowExpand). */
  const rowExpand = $derived(
    expandedIndex >= 0 && detailsHeight > 0
      ? { afterRow: expandedIndex, extra: detailsHeight }
      : undefined,
  );
  const graphHeight = $derived(
    displayCommits.length * ROW_HEIGHT + (rowExpand?.extra ?? 0),
  );

  /** The branch line leaving the synthetic row (drawn gray + dashed up to
   *  the first real commit it reaches). */
  const uncommittedBranch = $derived(
    displayCommits[0]?.oid === UNCOMMITTED
      ? layout.branches.find((b) => b.points[0]?.row === 0)
      : undefined,
  );

  async function loadPage(skip: number): Promise<void> {
    loading = true;
    error = null;
    try {
      const page = await gitLog(repoPath, { skip, limit: PAGE_SIZE });
      commits = skip === 0 ? page.commits : [...commits, ...page.commits];
      refs = skip === 0 ? page.refs : { ...refs, ...page.refs };
      hasMore = page.has_more;
      if (skip === 0) {
        headOid =
          Object.entries(page.refs).find(([, rs]) => rs.some((r) => r.kind === "Head"))?.[0] ??
          null;
        const summary = await gitSummary(repoPath);
        workingChanges = summary.ok
          ? summary.data.staged.length +
            summary.data.changes.length +
            summary.data.untracked.length +
            summary.data.merge.length
          : 0;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Genuine side effect (IPC) keyed on the repo this tab shows.
  $effect(() => {
    void repoPath;
    void loadPage(0);
  });

  function loadMore(): void {
    if (!loading && hasMore) void loadPage(commits.length);
  }

  function formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
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

  /** Near-bottom incremental loading for the plain scroller. */
  function handleScroll(event: Event): void {
    const el = event.target as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 20) {
      if (!loading && hasMore) void loadPage(commits.length);
    }
  }

  /** Combined ref chips — grouping math lives in domain/git-graph.ts. */
  function chipsFor(oid: string): RefChips {
    return groupRefChips(refs[oid] ?? []);
  }

  function refClass(kind: RefInfo["kind"]): string {
    switch (kind) {
      case "Head": return "ref-head";
      case "LocalBranch": return "ref-branch";
      case "RemoteBranch": return "ref-remote";
      case "Tag": return "ref-tag";
    }
  }

  interface Row {
    commit: CommitInfo;
    index: number;
  }
  const rows: Row[] = $derived(commits.map((commit, index) => ({ commit, index })));

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

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && (menu || prompt)) closeMenu();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="git-graph-view" data-testid="git-graph-view">
  {#if error}
    <div class="graph-status error">{error}</div>
  {:else if commits.length === 0 && loading}
    <div class="graph-status">Loading history…</div>
  {:else if commits.length === 0}
    <div class="graph-status">No commits.</div>
  {:else}
    <div class="graph-scroller" onscroll={handleScroll}>
      <div class="graph-body" style:height="{graphHeight}px">
        <svg
          class="graph-underlay"
          width={graphWidth}
          height={graphHeight}
          aria-hidden="true"
        >
          {#each layout.branches as line, li (li)}
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
          {#each layout.vertices as vertex, vi (vi)}
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

        {#each displayCommits as commit, index (commit.oid)}
          {@const chips = chipsFor(commit.oid)}
          {@const synthetic = commit.oid === UNCOMMITTED}
          <div
            class="commit-row"
            class:selected={selected?.oid === commit.oid}
            class:is-head={chips.isHead}
            class:uncommitted={synthetic}
            style:padding-left="{graphWidth + 20}px"
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
              <span class="author">{commit.author_name}</span>
              <span class="date">{formatDate(commit.author_time)}</span>
              <span class="oid">{commit.short_oid}</span>
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
              bind:clientHeight={detailsHeight}
              style:margin-left="{graphWidth + 12}px"
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

  {#if menu}
    <!-- Backdrop closes the menu on any outside interaction. -->
    <button
      class="menu-backdrop"
      aria-label="Close menu"
      onclick={closeMenu}
      oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}
    ></button>
    {@const m = menu}
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
    position: relative;
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

  .graph-scroller {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .graph-body {
    position: relative;
  }

  .graph-underlay {
    position: absolute;
    top: 0;
    left: 10px;
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
    background: var(--background-card, #1e1e1e);
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
    background: var(--background-card, #1e1e1e);
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
    background: var(--background-card, #1e1e1e);
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
