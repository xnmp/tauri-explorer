<!--
  PreviewDiffView — the preview pane's SCM diff: a working-tree diff with
  stage / unstage / discard / open-file actions (VSCode parity), or a
  commit / comparison file diff routed from the git graph (#366). Its chrome
  renders as direct children of `.preview-pane`, whose dock and fullscreen
  layout rules place it like the file and plugin-target chrome.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { gitDiff } from "$lib/api/git";
  import { gitCommitFileDiff, gitCompareCommitFileDiff } from "$lib/api/git-log";
  import { openFile } from "$lib/api/open";
  import { diffSubtitle as diffSubtitleOf, visibleDiffLines } from "$lib/domain/diff";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { createPreviewDiff } from "$lib/state/preview-diff.svelte";
  import { createPreviewDiffActions, type HunkAction } from "$lib/state/preview-diff-actions";
  import type { ScmStore } from "$lib/state/scm.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import PreviewDiffLines from "./PreviewDiffLines.svelte";

  /** The SCM store holding the open diff (the pane's, else the sidebar's). */
  const { scmStore }: { scmStore: ScmStore } = $props();

  const activeDiff = $derived(scmStore.activeDiff);
  // Commit file diff routed from the git graph (#366); wins over the
  // working-tree diff when both are somehow set (openers clear the other).
  const commitDiff = $derived(scmStore.commitDiff);
  const diffPath = $derived(commitDiff?.path ?? activeDiff?.path ?? "");
  const diff = createPreviewDiff({
    current: () => scmStore,
    workingDiff: (repoRoot, path, staged) => gitDiff(repoRoot, path, { staged }),
    commitFileDiff: gitCommitFileDiff,
    compareCommitFileDiff: gitCompareCommitFileDiff,
  });
  // Closing the diff unmounts this view: invalidate any in-flight request,
  // as the pane-lifetime loader did when the diff target went away.
  onDestroy(() => diff.clear());
  const diffVisibleLines = $derived(visibleDiffLines(diff.parsed));
  const diffSubtitle = $derived(diffSubtitleOf(diff.parsed, activeDiff?.staged ?? false));

  // Diff header actions — restore the stage / unstage / discard / open-file
  // affordances directly on the diff so a file can be staged from its diff
  // (VSCode parity). Operates on the currently-open diff target.
  // Admission is against the pane owning the diff, shared with command routing.
  let ownershipRevision = $state(0);
  $effect(() => dialogStore.subscribeOwnership(() => { ownershipRevision++; }));
  const diffActions = createPreviewDiffActions({
    scm: () => scmStore,
    ownerPaneId: () => windowTabsManager.activePaneId,
    isPaneBlocked: (id) => dialogStore.isPaneBlocked(id),
    onError: (message) => toastStore.error(message),
    confirm: (message) => window.confirm(message),
  });
  const diffActionsBlocked = $derived.by(() => {
    void ownershipRevision;
    return diffActions.blocked();
  });
  const stageFromDiff = () => diffActions.stage();
  const unstageFromDiff = () => diffActions.unstage();
  const discardFromDiff = () => diffActions.discard();
  const applyHunk = (patch: string, action: HunkAction) => diffActions.applyHunk(patch, action);
  async function openDiffFileInEditor(): Promise<void> {
    if (!activeDiff || !scmStore.repoRoot) return;
    const abs = `${scmStore.repoRoot.replace(/\/$/, "")}/${activeDiff.path}`;
    await openFile(abs);
  }

  $effect(() => {
    if (commitDiff) {
      void diff.loadCommit(commitDiff);
      return;
    }
    if (!activeDiff || !scmStore.repoRoot) {
      diff.clear();
      return;
    }
    // Depend on the summary object itself (replaced wholesale on refresh) —
    // counts can stay identical while file contents change, so a count-based
    // key would miss content updates.
    void scmStore.summary;
    void diff.load(scmStore.repoRoot, activeDiff.path, activeDiff.staged);
  });
</script>

<div class="preview-header">
  <span class="preview-filename" title={diffPath}>{diffPath.split("/").pop()}</span>
  {#if commitDiff}
    <span class="preview-type-badge diff-commit" title={commitDiff.baseOid ? `${commitDiff.baseOid} → ${commitDiff.oid}` : commitDiff.oid}>
      {commitDiff.baseOid ? `compare ${commitDiff.baseOid.slice(0, 7)} → ${commitDiff.oid.slice(0, 7)}` : `commit ${commitDiff.oid.slice(0, 7)}`}
    </span>
  {:else if activeDiff}
    <span class="preview-type-badge" class:diff-staged={activeDiff.staged} class:diff-unstaged={!activeDiff.staged}>
      {diffSubtitle || "git diff"}
    </span>
  {/if}
</div>
<div class="diff-actions">
  {#if commitDiff}
    <!-- Historical diff: stage/unstage/discard don't apply (#366). -->
    <button type="button" class="diff-action-btn" title="Close diff (Esc)" onclick={() => scmStore.closeCommitDiff()}>Close</button>
  {:else if activeDiff}
    <button type="button" class="diff-action-btn" disabled={diffActionsBlocked} onclick={openDiffFileInEditor}>Open File</button>
    {#if activeDiff.staged}
      <button type="button" class="diff-action-btn" disabled={diffActionsBlocked} onclick={unstageFromDiff}>Unstage</button>
    {:else}
      <button type="button" class="diff-action-btn" disabled={diffActionsBlocked} onclick={stageFromDiff}>Stage</button>
      {#if !diff.parsed?.added}
        <button type="button" class="diff-action-btn danger" disabled={diffActionsBlocked} onclick={discardFromDiff}>Discard</button>
      {/if}
    {/if}
    <button type="button" class="diff-action-btn" title="Close diff (Esc)" onclick={() => scmStore.closeDiff()}>Close</button>
  {/if}
</div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-focusable (WCAG 2.1.1, #797). -->
<div class="preview-content" role="region" aria-label="Diff of {diffPath}" tabindex="0">
  {#if diff.loading}
    <div class="preview-loading"><div class="spinner"></div></div>
  {:else if diff.error}
    <div class="preview-empty"><span class="preview-error-text">{diff.error}</span></div>
  {:else if diff.parsed?.binary}
    <div class="preview-empty"><span>Binary file changed</span></div>
  {:else if diffVisibleLines.length === 0}
    <div class="preview-empty"><span>No changes to display</span></div>
  {:else}
    <PreviewDiffLines lines={diffVisibleLines} parsed={diff.parsed} path={diffPath} {activeDiff}
      blocked={diffActionsBlocked} onApplyHunk={applyHunk} />
  {/if}
</div>
<div class="preview-info">
  <div class="info-row">
    <span class="info-label">Path</span>
    <span class="info-value" title={diffPath}>{diffPath}</span>
  </div>
</div>

<style>
  .preview-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 10px;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    padding: 32px;
    text-align: center;
  }

  .preview-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px var(--preview-info-inset) 14px;
    border-bottom: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .preview-filename {
    font-size: var(--font-size-body);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-type-badge {
    display: inline-flex;
    align-self: flex-start;
    font-size: 10px;
    line-height: 1;
    color: var(--accent-text, var(--accent));
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: 3px 8px;
    border-radius: var(--radius-pill);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    font-weight: 500;
  }

  .preview-content {
    position: relative;
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .preview-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 24px;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 1.5px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .preview-error-text {
    color: var(--system-critical-text, var(--system-critical));
    font-size: var(--font-size-caption);
  }

  .preview-info {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    border-top: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-caption);
    padding: 8px var(--preview-info-inset);
    border-bottom: 1px solid var(--divider);
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .info-label {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .info-value {
    color: var(--text-secondary);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Fullscreen keeps the pane's own content-box rule for the diff region. */
  :global(.preview-pane.fullscreen) > .preview-content {
    overflow: hidden;
  }

  /* --- Git diff styles --- */
  .preview-type-badge.diff-staged {
    background: color-mix(in srgb, #22c55e 20%, transparent);
    color: #16a34a;
  }

  .preview-type-badge.diff-unstaged {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent-text, var(--accent));
  }

  .diff-actions {
    display: flex;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--divider);
    flex-wrap: wrap;
  }

  .diff-action-btn {
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .diff-action-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .diff-action-btn.danger:hover {
    color: var(--system-critical-text, var(--system-critical, #dc2626));
    border-color: var(--system-critical, #dc2626);
  }
</style>
