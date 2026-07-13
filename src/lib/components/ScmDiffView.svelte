<!--
  ScmDiffView - unified diff viewer that replaces the FileList in the
  active pane when a SCM row is clicked (#55).

  - Virtualized line rendering for >2k-line diffs.
  - Renders +/− gutters with old/new line numbers per line.
  - Detects added / deleted / renamed files and surfaces them in the
    header; binary files show a placeholder.
  - Header actions: open file, stage/unstage, discard (worktree only).
  - Escape or clicking Back returns to the file list.
-->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import { getScmStore } from "$lib/state/scm.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";

  const scmStore = getScmStore(getPaneIdContext() ?? "default");
  import { gitDiff, openFile } from "$lib/api/files";
  import { parseUnifiedDiff, type ParsedDiff, type DiffLine } from "$lib/domain/diff";
  import { toastStore } from "$lib/state/toast.svelte";
  import VirtualList from "$lib/components/VirtualList.svelte";

  interface Props {
    repoPath: string;
    path: string;
    staged: boolean;
  }

  let { repoPath, path, staged }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let parsed = $state<ParsedDiff | null>(null);
  let rootEl = $state<HTMLDivElement | null>(null);
  let requestGen = 0;

  async function fetchDiff(repo: string, file: string, isStaged: boolean): Promise<void> {
    const gen = ++requestGen;
    const isInitial = parsed === null;
    if (isInitial) loading = true;
    error = null;
    const r = await gitDiff(repo, file, { staged: isStaged });
    // Drop stale responses — a newer request (different row / staged flag /
    // refresh) superseded this one while it was in flight.
    if (gen !== requestGen) return;
    if (!r.ok) {
      error = r.error;
      parsed = null;
      loading = false;
      return;
    }
    parsed = parseUnifiedDiff(r.data);
    loading = false;
  }

  onMount(() => {
    tick().then(() => rootEl?.focus());
  });

  // Reset parsed when viewing a different file/mode so we show loading state.
  $effect(() => {
    void path;
    void staged;
    void repoPath;
    parsed = null;
    error = null;
  });

  // Refetch when the target or the SCM summary changes. Depend on the summary
  // object itself (replaced wholesale on refresh) — counts can stay identical
  // while contents change, so a count-based key would miss updates.
  $effect(() => {
    void scmStore.summary;
    fetchDiff(repoPath, path, staged);
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      scmStore.closeDiff();
    }
  }

  async function openInEditor(): Promise<void> {
    const abs = `${repoPath.replace(/\/$/, "")}/${path}`;
    await openFile(abs);
  }

  async function stage(): Promise<void> {
    await scmStore.stage([path]);
  }

  async function unstage(): Promise<void> {
    await scmStore.unstage([path]);
  }

  async function discard(): Promise<void> {
    const r = await scmStore.discard([path]);
    if (r.ok) {
      scmStore.closeDiff();
    } else {
      toastStore.error(`Discard failed: ${r.error}`);
    }
  }

  const headerSubtitle = $derived.by(() => {
    if (!parsed) return "";
    if (parsed.added) return "added";
    if (parsed.deleted) return "deleted";
    if (parsed.oldPath && parsed.newPath && parsed.oldPath !== parsed.newPath) {
      return `renamed from ${parsed.oldPath}`;
    }
    return staged ? "staged" : "unstaged";
  });

  const visibleLines = $derived.by<DiffLine[]>(() => {
    if (!parsed) return [];
    // Hide file meta lines (diff --git, ---, +++) — the header shows file info.
    return parsed.lines.filter((l) => l.kind !== "header" && l.kind !== "meta");
  });

  function lineClass(kind: DiffLine["kind"]): string {
    switch (kind) {
      case "add": return "line add";
      case "remove": return "line remove";
      case "hunk": return "line hunk";
      case "binary": return "line binary";
      default: return "line context";
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="diff-view"
  bind:this={rootEl}
  tabindex="0"
  role="document"
  aria-label="Diff for {path}"
  onkeydown={onKeydown}
>
  <div class="diff-header">
    <button
      type="button"
      class="back-btn"
      onclick={() => scmStore.closeDiff()}
      title="Back to files (Esc)"
      aria-label="Back to file list"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M10 4L6 8L10 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Back</span>
    </button>
    <div class="path-label" title={path}>
      <span class="file-path">{path}</span>
      <span class="badge" class:staged class:unstaged={!staged}>{headerSubtitle}</span>
    </div>
    <div class="header-actions">
      <button type="button" class="action-btn" onclick={openInEditor}>Open File</button>
      {#if staged}
        <button type="button" class="action-btn" onclick={unstage}>Unstage</button>
      {:else}
        <button type="button" class="action-btn" onclick={stage}>Stage</button>
        {#if !parsed?.added}
          <button type="button" class="action-btn danger" onclick={discard}>Discard</button>
        {/if}
      {/if}
    </div>
  </div>

  <div class="diff-body">
    {#if loading}
      <div class="diff-placeholder">Loading diff…</div>
    {:else if error}
      <div class="diff-placeholder error">Failed to load diff: {error}</div>
    {:else if parsed && parsed.binary}
      <div class="diff-placeholder">Binary file changed</div>
    {:else if !parsed || visibleLines.length === 0}
      <div class="diff-placeholder">No changes to display</div>
    {:else}
      <VirtualList items={visibleLines} itemHeight={20} getKey={(l) => l.index}>
        {#snippet children(line: DiffLine)}
          <div class={lineClass(line.kind)} data-line-kind={line.kind}>
            <span class="gutter old">{line.oldLine ?? ""}</span>
            <span class="gutter new">{line.newLine ?? ""}</span>
            <span class="sigil">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "hunk" ? "@" : " "}</span>
            <span class="content">{line.text}</span>
          </div>
        {/snippet}
      </VirtualList>
    {/if}
  </div>
</div>

<style>
  .diff-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: var(--background-card);
    color: var(--text-primary);
  }

  .diff-view:focus {
    outline: none;
  }

  .diff-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
    font-family: inherit;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .back-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .path-label {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .file-path {
    font-size: 13px;
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
    font-weight: var(--font-weight-semibold);
  }

  .badge.staged {
    background: color-mix(in srgb, #22c55e 25%, transparent);
    color: #16a34a;
  }

  .badge.unstaged {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent);
  }

  .header-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .action-btn {
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .action-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .action-btn.danger:hover {
    color: var(--system-critical, #dc2626);
    border-color: var(--system-critical, #dc2626);
  }

  .diff-body {
    display: flex;
    flex: 1;
    min-height: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    overflow: hidden;
  }

  .diff-body :global(.virtual-list) {
    flex: 1;
    min-height: 0;
  }

  .diff-placeholder {
    margin: 24px auto;
    color: var(--text-tertiary);
    font-size: 13px;
    text-align: center;
  }

  .diff-placeholder.error {
    color: var(--system-critical, #dc2626);
  }

  .line {
    display: grid;
    grid-template-columns: 52px 52px 16px 1fr;
    align-items: center;
    min-height: 20px;
    line-height: 20px;
    white-space: pre;
    padding-right: 12px;
  }

  .line.context {
    background: transparent;
  }

  .line.add {
    background: color-mix(in srgb, #22c55e 12%, transparent);
  }

  .line.remove {
    background: color-mix(in srgb, #ef4444 14%, transparent);
  }

  .line.hunk {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--text-tertiary);
  }

  .line.binary {
    color: var(--text-tertiary);
    font-style: italic;
  }

  .gutter {
    padding-right: 8px;
    text-align: right;
    color: var(--text-tertiary);
    user-select: none;
    border-right: 1px solid color-mix(in srgb, var(--divider) 50%, transparent);
  }

  .sigil {
    text-align: center;
    color: var(--text-tertiary);
    user-select: none;
  }

  .line.add .sigil {
    color: #16a34a;
  }

  .line.remove .sigil {
    color: #dc2626;
  }

  .content {
    padding-left: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: text;
  }
</style>
