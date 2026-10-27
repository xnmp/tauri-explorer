<!--
  GitGraphCommitDetail — contents of the inline details block expanded
  below the selected commit row (VSCode Git Graph parity, #221): message,
  optional metadata (#402), comparison controls (#512) and changed files
  with inline diffs. On the uncommitted node the message area becomes the
  commit box and files are grouped by index section (#466). The parent owns
  the block's frame, position and measured height.
-->
<script lang="ts">
  import type { GraphCommit as CommitInfo } from "$lib/state/git-graph-cache";
  import type { DetailFile, GitGraphDetail } from "$lib/state/git-graph-detail.svelte";
  import type { CommitPanelStore } from "$lib/state/commit-panel.svelte";
  import { uncommittedCommitEnabled, type GitGraphWorkingTree } from "$lib/state/git-graph-working-tree";
  import { commitButtonLabel, groupStageFiles, stagedCountOf, stageFilesOf } from "$lib/domain/commit-panel";
  import { highlightDiffLine } from "$lib/domain/syntax-highlight";
  import { splitPathForDisplay } from "$lib/domain/path";

  interface Props {
    commit: CommitInfo;
    synthetic: boolean;
    showMeta: boolean;
    detail: GitGraphDetail;
    commitPanel: CommitPanelStore;
    workingTree: GitGraphWorkingTree;
    formatDate: (unixSeconds: number) => string;
    onBeginComparison: () => void;
    onExitComparison: () => void;
    onClose: () => void;
  }

  const {
    commit, synthetic, showMeta, detail, commitPanel, workingTree, formatDate,
    onBeginComparison, onExitComparison, onClose,
  }: Props = $props();

  const selectedFiles = $derived(detail.files);
  const comparisonFirst = $derived(detail.comparisonFirst);
  const comparison = $derived(detail.comparison);
  const openDiff = $derived(detail.openDiff);
  const diffLoading = $derived(detail.diffLoading);
  // Grouped file sections + commit-button enablement are pure derivations
  // (domain/commit-panel).
  const stageFiles = $derived(stageFilesOf(selectedFiles));
  const stageGroups = $derived(groupStageFiles(stageFiles));
  const stagedCount = $derived(stagedCountOf(stageFiles));
  const commitEnabled = $derived(uncommittedCommitEnabled(commitPanel.message, selectedFiles));

  function onCommitBoxKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // Ctrl/Cmd+Enter commits; plain Enter inserts a newline (multiline message).
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void workingTree.commit();
    }
  }
</script>

<div class="detail-columns">
  {#if !synthetic}
    <div class="detail-meta-col">
      <!-- Metadata hidden by default (#402); toggle via the
           header context menu ("Details metadata"). -->
      {#if showMeta}
        <div class="meta-line"><span class="meta-label">Commit:</span> <span class="meta-mono">{commit.oid}</span></div>
        <div class="meta-line"><span class="meta-label">Parents:</span> <span class="meta-mono">{commit.parents.map((p) => p.slice(0, 8)).join(", ") || "—"}</span>{#if commit.parents.length > 1} <span class="meta-note">(merge of {commit.parents.length} parents)</span>{/if}</div>
        <div class="meta-line"><span class="meta-label">Author:</span> {commit.author_name} &lt;{commit.author_email}&gt;</div>
        <div class="meta-line"><span class="meta-label">Date:</span> {formatDate(commit.author_time)}</div>
      {/if}
      <p class="detail-message">{commit.summary.trimStart()}</p>
      {#if comparisonFirst}
        <p class="compare-status">Select another commit to compare with {comparisonFirst.short_oid}.</p>
        <button type="button" class="compare-action" onclick={onExitComparison}>
          Cancel comparison
        </button>
      {:else if comparison}
        <p class="compare-status">Comparing {comparison.older.short_oid} → {comparison.newer.short_oid}</p>
        <button type="button" class="compare-action" onclick={onExitComparison}>
          Exit comparison
        </button>
      {:else}
        <button type="button" class="compare-action" onclick={onBeginComparison}>
          Compare this commit
        </button>
      {/if}
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
        value={commitPanel.message}
        oninput={(e) => commitPanel.setMessage(e.currentTarget.value)}
        onkeydown={onCommitBoxKeydown}
      ></textarea>
      {#if commitPanel.error}
        <div class="commit-box-error" role="alert">{commitPanel.error}</div>
      {/if}
      <div class="commit-box-actions">
        <button
          type="button"
          class="commit-box-btn"
          data-testid="git-graph-commit-btn"
          disabled={!commitEnabled || commitPanel.committing}
          title="Commit staged changes (Ctrl+Enter)"
          onclick={() => void workingTree.commit()}
        >
          {commitButtonLabel(stagedCount)}
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
      {#if detail.isDiffOpen(file)}
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
                  onclick={() => void workingTree.unstagePaths(group.files.map((f) => f.path))}
                >Unstage all</button>
              {:else}
                <button
                  type="button"
                  class="stage-all-btn"
                  title="Stage all"
                  onclick={() => void workingTree.stagePaths(group.files.map((f) => f.path))}
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
                      class:open={detail.isDiffOpen(file)}
                      onclick={() => void workingTree.toggleFileDiff(file)}
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
                        onclick={() => void workingTree.unstagePaths([file.path])}
                      >{@render stageActionIcon("unstage")}</button>
                    {:else}
                      <button
                        type="button"
                        class="stage-btn"
                        title="Stage {file.path}"
                        aria-label="Stage {file.path}"
                        onclick={() => void workingTree.stagePaths([file.path])}
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
              class:open={detail.isDiffOpen(file)}
              onclick={() => void workingTree.toggleFileDiff(file)}
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

<style>
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

  .compare-status {
    margin: 6px 0;
    color: var(--text-muted);
    font-size: 12px;
  }

  .compare-action {
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 12px;
    padding: 3px 7px;
  }

  .compare-action:hover {
    background: var(--bg-hover);
  }

  /* A large commit must not make its inline detail panel taller than the
     graph. Keep the list itself as the scrolling region so the commit message
     and close button stay put while every changed file remains reachable. */
  .detail-files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 320px;
    overflow-y: auto;
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
</style>
