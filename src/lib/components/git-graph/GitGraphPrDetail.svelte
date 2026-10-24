<!--
  GitGraphPrDetail — contents of the in-app PR details dropdown (#459)
  anchored under a commit row: title and actions (#1082), description and
  comments (#468), CI status with failed-check logs (#521) and review
  threads. The parent owns the expansion frame, position and height.
-->
<script lang="ts">
  import { ciStatusLabel, prDescription, prDetailComments, reviewDecisionLabel } from "$lib/domain/git-graph";
  import { openExternalUrl } from "$lib/api/crash";
  import type { GitPrSession, PrSnapshot } from "$lib/state/git-pr-session.svelte";

  interface Props {
    pr: PrSnapshot;
    prSession: GitPrSession;
    onPrAction: (action: "merge" | "approve", pr: PrSnapshot) => void;
  }

  const { pr, prSession, onPrAction }: Props = $props();

  const ciLine = $derived(ciStatusLabel(pr.ciStatus));
  const reviewLine = $derived(reviewDecisionLabel(pr.reviewDecision));
  const description = $derived(prDescription(pr.body));
  const comments = $derived(prDetailComments(pr.comments, Date.now()));
  const failedCiChecks = $derived(prSession.failedCiChecks);
  const failedCiChecksLoading = $derived(prSession.failedCiChecksLoading);
  const ciCheckLog = $derived(prSession.ciCheckLog);
  const prActionBusy = $derived(prSession.actionBusy);
</script>

<div class="pr-detail-body">
  <div class="pr-detail-head">
    <span class="pr-detail-number">#{pr.number}</span>
    <span class="pr-detail-title">{pr.title}</span>
    {#if pr.draft}<span class="pr-detail-chip draft">Draft</span>{/if}
    <!-- The PR page opens in the default browser (host-pinned to github.com). -->
    <button type="button" class="pr-detail-open" onclick={() => void openExternalUrl(pr.htmlUrl)}>
      Open on GitHub ↗
    </button>
    <button type="button" class="prompt-btn" disabled={prActionBusy || pr.draft} onclick={() => onPrAction("merge", pr)}>Merge PR</button>
    <button type="button" class="prompt-btn" disabled={prActionBusy || pr.draft} onclick={() => onPrAction("approve", pr)}>Approve PR</button>
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
  {#if pr.ciStatus === "failure"}
    {#if failedCiChecksLoading}
      <div class="pr-detail-line">Loading failed checks…</div>
    {:else if failedCiChecks?.prNumber === pr.number && failedCiChecks.error}
      <div class="pr-detail-error">Could not load failed checks: {failedCiChecks.error}</div>
    {:else if failedCiChecks?.prNumber === pr.number && failedCiChecks.checks.length > 0}
      <div class="pr-detail-ci-checks" aria-label="Failed CI checks">
        {#each failedCiChecks.checks as check (check.jobId)}
          <button type="button" class="pr-detail-ci-check" onclick={() => void prSession.openCheckLog(pr, check)}>{check.name}</button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if ciCheckLog?.prNumber === pr.number}
    <div class="pr-detail-ci-log" data-testid="git-graph-ci-check-log">
      <div class="pr-detail-ci-log-head">
        <strong>{ciCheckLog.check.name}</strong>
        <button type="button" class="detail-close" onclick={prSession.closeCheckLog} aria-label="Close CI check log">✕</button>
      </div>
      {#if ciCheckLog.error}
        <div class="pr-detail-error">Could not load CI check log: {ciCheckLog.error}</div>
      {:else if ciCheckLog.result}
        <pre>{ciCheckLog.result.log}</pre>
      {:else}
        <div class="pr-detail-line">Loading failed check log…</div>
      {/if}
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
  <section class="pr-detail-threads" data-testid="git-graph-pr-review-threads">
    <div class="pr-detail-label">Review threads</div>
    {#if pr.reviewThreads == null}
      <div class="pr-detail-line">Sign in to GitHub to view review threads.</div>
    {:else if pr.reviewThreads.length === 0}
      <div class="pr-detail-line">No review threads.</div>
    {:else}
      <ul class="pr-detail-comments pr-detail-thread-list">
        {#each pr.reviewThreads as thread, index (`${thread.resolved}-${index}`)}
          <li class="pr-detail-comment pr-detail-thread">
            <div class:resolved={thread.resolved} class="pr-detail-thread-state">
              {thread.resolved ? "Resolved" : "Open"}
            </div>
            {#each thread.comments as comment, commentIndex (`${comment.createdAt}-${commentIndex}`)}
              <div class="pr-detail-thread-comment">
                <div class="pr-detail-comment-meta">
                  <span class="pr-detail-comment-author">{comment.author ?? "(unknown)"}</span>
                  {#if comment.path}
                    <span class="pr-detail-thread-anchor">{comment.path}{comment.line == null ? "" : `:${comment.line}`}</span>
                  {/if}
                </div>
                <div class="pr-detail-comment-body">{comment.body}</div>
              </div>
            {/each}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
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
  .pr-detail-ci-checks {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pr-detail-ci-check {
    font: inherit;
    color: var(--system-critical-text, var(--system-critical));
    background: color-mix(in srgb, var(--system-critical) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--system-critical) 35%, transparent);
    border-radius: 5px;
    cursor: pointer;
    padding: 2px 7px;
  }
  .pr-detail-ci-check:hover { background: color-mix(in srgb, var(--system-critical) 22%, transparent); }
  .pr-detail-ci-log {
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: 6px;
    overflow: hidden;
  }
  .pr-detail-ci-log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    color: var(--text-primary);
    background: var(--background-card);
  }
  .pr-detail-ci-log pre {
    margin: 0;
    max-height: 300px;
    overflow: auto;
    padding: 8px;
    white-space: pre-wrap;
    color: var(--text-secondary);
    background: var(--background-base);
  }
  .pr-detail-error { color: var(--system-critical-text, var(--system-critical)); }
  .pr-detail-label {
    color: var(--text-tertiary);
    margin-right: 2px;
  }
  .pr-detail-ci.ci-success {
    color: var(--system-success-text, var(--system-success));
    font-weight: 600;
  }
  .pr-detail-ci.ci-failure {
    color: var(--system-critical-text, var(--system-critical));
    font-weight: 600;
  }
  .pr-detail-ci.ci-pending {
    color: var(--system-caution-text, var(--system-caution));
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
  .pr-detail-threads {
    margin-top: 10px;
  }
  .pr-detail-thread-list {
    max-height: 280px;
  }
  .pr-detail-thread {
    border-left-color: color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .pr-detail-thread-state {
    display: inline-block;
    margin-bottom: 5px;
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, #f59e0b 55%, transparent);
    border-radius: 999px;
    color: #f59e0b;
    font-size: var(--font-size-caption);
    font-weight: 700;
  }
  .pr-detail-thread-state.resolved {
    border-color: color-mix(in srgb, #22c55e 55%, transparent);
    color: #22c55e;
  }
  .pr-detail-thread-comment + .pr-detail-thread-comment {
    margin-top: 7px;
  }
  .pr-detail-thread-anchor {
    color: var(--text-tertiary);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-caption);
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
