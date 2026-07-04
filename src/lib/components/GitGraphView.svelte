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
  import { assignLanes, type GraphLayout } from "$lib/domain/git-graph";
  import { notifyLocalGitChange } from "$lib/state/git-refresh";
  import { toastStore } from "$lib/state/toast.svelte";
  import VirtualList from "./VirtualList.svelte";

  const { repoPath }: { repoPath: string } = $props();

  const ROW_HEIGHT = 28;
  const LANE_WIDTH = 14;
  const PAGE_SIZE = 200;
  const LANE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#a78bfa", "#14b8a6"];

  let commits = $state<CommitInfo[]>([]);
  let refs = $state<Record<string, RefInfo[]>>({});
  let hasMore = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let selected = $state<CommitInfo | null>(null);
  let selectedFiles = $state<CommitFile[]>([]);

  async function selectCommit(commit: CommitInfo): Promise<void> {
    if (selected?.oid === commit.oid) {
      selected = null;
      return;
    }
    selected = commit;
    selectedFiles = [];
    try {
      selectedFiles = await gitCommitFiles(repoPath, commit.oid);
    } catch {
      selectedFiles = [];
    }
  }

  const layout: GraphLayout = $derived(assignLanes(commits));
  const graphWidth = $derived(Math.max(2, layout.laneCount) * LANE_WIDTH);

  async function loadPage(skip: number): Promise<void> {
    loading = true;
    error = null;
    try {
      const page = await gitLog(repoPath, { skip, limit: PAGE_SIZE });
      commits = skip === 0 ? page.commits : [...commits, ...page.commits];
      refs = skip === 0 ? page.refs : { ...refs, ...page.refs };
      hasMore = page.has_more;
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

  function laneColor(lane: number): string {
    return LANE_COLORS[lane % LANE_COLORS.length];
  }

  /** Cubic segment from this row's baseline to the next row's. */
  function edgePath(from: number, to: number): string {
    const x1 = from * LANE_WIDTH + LANE_WIDTH / 2;
    const x2 = to * LANE_WIDTH + LANE_WIDTH / 2;
    const y1 = ROW_HEIGHT / 2;
    const y2 = ROW_HEIGHT * 1.5;
    return `M ${x1} ${y1} C ${x1} ${ROW_HEIGHT}, ${x2} ${ROW_HEIGHT}, ${x2} ${y2}`;
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

  function openMenu(event: MouseEvent, commit: CommitInfo): void {
    event.preventDefault();
    prompt = null;
    menu = {
      x: event.clientX,
      y: event.clientY,
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
  <header class="graph-header">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
      <circle cx="11.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
      <path d="M4 5.1V10.9M11.5 5.1V6.5C11.5 8.2 10 9 8 9H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
    <span class="repo-path" title={repoPath}>{repoPath}</span>
    <span class="count">{commits.length}{hasMore ? "+" : ""} commits</span>
  </header>

  {#if error}
    <div class="graph-status error">{error}</div>
  {:else if commits.length === 0 && loading}
    <div class="graph-status">Loading history…</div>
  {:else if commits.length === 0}
    <div class="graph-status">No commits.</div>
  {:else}
    <VirtualList
      class="graph-scroller"
      items={rows}
      itemHeight={ROW_HEIGHT}
      getKey={(row) => row.commit.oid}
      onnearend={loadMore}
    >
      {#snippet children(row)}
        {@const graphRow = layout.rows[row.index]}
        {@const decorations = refs[row.commit.oid] ?? []}
        <div
          class="commit-row"
          class:selected={selected?.oid === row.commit.oid}
          class:is-head={(refs[row.commit.oid] ?? []).some((r) => r.kind === "Head")}
          data-oid={row.commit.short_oid}
          role="button"
          tabindex="0"
          onclick={() => void selectCommit(row.commit)}
          onkeydown={(e) => { if (e.key === "Enter") void selectCommit(row.commit); }}
          oncontextmenu={(e) => openMenu(e, row.commit)}
        >
          <svg class="graph-cell" width={graphWidth} height={ROW_HEIGHT} aria-hidden="true">
            {#if graphRow}
              {#each graphRow.edges as edge (edge.from + "-" + edge.to)}
                <path d={edgePath(edge.from, edge.to)} stroke={laneColor(edge.to)} stroke-width="2" fill="none" />
              {/each}
              <circle
                cx={graphRow.lane * LANE_WIDTH + LANE_WIDTH / 2}
                cy={ROW_HEIGHT / 2}
                r="4"
                fill={laneColor(graphRow.lane)}
              />
            {/if}
          </svg>
          <span class="oid">{row.commit.short_oid}</span>
          {#each decorations as ref (ref.kind + ref.name)}
            <span class="ref {refClass(ref.kind)}">{ref.name}</span>
          {/each}
          <span class="summary" title={row.commit.summary}>{row.commit.summary}</span>
          <span class="author">{row.commit.author_name}</span>
          <span class="date">{formatDate(row.commit.author_time)}</span>
        </div>
      {/snippet}
    </VirtualList>
  {/if}

  {#if selected}
    <aside class="commit-detail" data-testid="git-graph-detail">
      <div class="detail-head">
        <span class="oid">{selected.short_oid}</span>
        <span class="detail-summary">{selected.summary}</span>
        <button class="detail-close" onclick={() => (selected = null)} aria-label="Close details">✕</button>
      </div>
      <div class="detail-meta">
        {selected.author_name} &lt;{selected.author_email}&gt; · {formatDate(selected.author_time)}
        {#if selected.parents.length > 1}· merge of {selected.parents.length} parents{/if}
      </div>
      <ul class="detail-files">
        {#each selectedFiles as file (file.path)}
          <li><span class="file-status s-{file.status}">{file.status}</span><span class="file-path">{file.path}</span></li>
        {:else}
          <li class="file-empty">No file changes (or still loading…)</li>
        {/each}
      </ul>
    </aside>
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

  .graph-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--divider);
    color: var(--text-secondary);
    font-size: 12px;
    flex-shrink: 0;
  }

  .repo-path {
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    margin-left: auto;
    color: var(--text-tertiary);
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

  .commit-detail {
    flex-shrink: 0;
    max-height: 40%;
    overflow-y: auto;
    border-top: 1px solid var(--divider);
    padding: 10px 14px;
    font-size: 12px;
    background: var(--background-card);
  }

  .detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .detail-summary {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-close {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 11px;
  }

  .detail-meta {
    color: var(--text-tertiary);
    margin: 4px 0 8px;
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
    gap: 8px;
    align-items: baseline;
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

  .graph-cell {
    flex-shrink: 0;
    overflow: visible;
  }

  .oid {
    font-family: var(--font-mono, monospace);
    color: var(--text-tertiary);
    flex-shrink: 0;
    width: 52px;
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
