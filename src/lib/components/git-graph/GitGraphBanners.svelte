<!--
  GitGraphBanners — the strips above the graph header: the PR action
  toolbar and status (#1082), the standing detached-HEAD banner (#524) and
  the cancellable network-operation banner (#528, ADR 0006).
-->
<script lang="ts">
  import { cancelGitNetworkOperation } from "$lib/api/git-log";
  import type { DetachedHeadIndicator } from "$lib/domain/git-graph";
  import { cancelActiveGitNetworkOperation, type GitNetworkOperation } from "$lib/state/git-graph-refresh";
  import type { GitPrSession } from "$lib/state/git-pr-session.svelte";
  import { toastStore } from "$lib/state/toast.svelte";

  interface Props {
    repoPath: string;
    headBranch: string | null;
    prSession: GitPrSession;
    /** Whether the PR confirmation dialog is open (it shows errors itself). */
    prDialogOpen: boolean;
    detachedIndicator: DetachedHeadIndicator | null;
    networkOperation: GitNetworkOperation | null;
    onCreatePr: () => void;
  }

  const {
    repoPath, headBranch, prSession, prDialogOpen, detachedIndicator, networkOperation, onCreatePr,
  }: Props = $props();

  const prActionBusy = $derived(prSession.actionBusy);
  const prActionResult = $derived(prSession.actionResult);
  const prActionError = $derived(prSession.actionError);

  async function cancelNetworkOperation(): Promise<void> {
    try {
      await cancelActiveGitNetworkOperation(cancelGitNetworkOperation);
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : String(err));
    }
  }
</script>

<div class="pr-actions-toolbar">
  <button type="button" class="prompt-btn" disabled={!headBranch || prActionBusy || prSession.prsByBranch.has(headBranch)} onclick={onCreatePr} title={headBranch ? `Create a PR for ${headBranch}` : "Check out a branch to create a PR"}>Create PR</button>
  {#if prActionBusy}<span role="status">GitHub PR action in progress…</span>{/if}
  {#if prActionResult && !prActionBusy}
    <span role="status" class="pr-actions-status">
      {#if prActionResult.action === "create"}PR created: {prActionResult.output}
      {:else if prActionResult.action === "merge"}Merge requested for PR #{prActionResult.prNumber}; GitHub may queue it.
      {:else}PR #{prActionResult.prNumber} approved{/if}
    </span>
  {/if}
  {#if prActionError && !prDialogOpen}<span role="alert" class="pr-detail-error">{prActionError}</span>{/if}
</div>
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
{#if networkOperation?.repoPath === repoPath}
  <div class="network-operation-banner" role="status">
    <span>
      {networkOperation.cancellable
        ? `Git ${networkOperation.label} in progress…`
        : `Finishing Git ${networkOperation.label}…`}
    </span>
    {#if networkOperation.cancellable}
      <button
        type="button"
        aria-label="Cancel {networkOperation.label}"
        disabled={networkOperation.cancelling}
        onclick={() => void cancelNetworkOperation()}
      >
        {networkOperation.cancelling ? "Cancelling…" : "Cancel"}
      </button>
    {/if}
  </div>
{/if}

<style>
  .pr-actions-toolbar { display: flex; align-items: center; gap: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-md); border-bottom: 1px solid var(--surface-stroke); font-size: var(--font-size-caption); }
  .pr-actions-status { overflow-wrap: anywhere; }

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

  .network-operation-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-height: 40px;
    flex-shrink: 0;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--accent) 9%, var(--background-card));
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 32%, var(--divider));
    font-size: var(--font-size-small);
  }

  .network-operation-banner button {
    position: relative;
    min-width: 64px;
    min-height: 28px;
    padding: 3px 10px;
    color: var(--text-primary);
    background: var(--background-card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm, 4px);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .network-operation-banner button::after {
    content: "";
    position: absolute;
    inset: -6px 0;
  }

  .network-operation-banner button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent-text, var(--accent));
  }

  .network-operation-banner button:active:not(:disabled) {
    scale: 0.96;
  }

  .network-operation-banner button:disabled {
    opacity: 0.65;
    cursor: default;
  }

  .pr-detail-error { color: var(--system-critical-text, var(--system-critical)); }

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
