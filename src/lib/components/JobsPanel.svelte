<!--
  Jobs Panel - Background job status viewer (Ctrl+J)
-->
<script lang="ts">
  import { isJobActive, jobsStore, type Job } from "$lib/state/jobs.svelte";
  import { retryJobAndRefocus } from "$lib/composables/use-job-retry";
  import { basename } from "$lib/domain/path";
  import Modal from "./Modal.svelte";
  import AiOperationsDialog from "./AiOperationsDialog.svelte";
  import { jobStateLabel } from "$lib/domain/native-plugin-jobs";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let panel: HTMLElement | undefined = $state();
  let unresolvedOpen = $state(false);

  // Live elapsed time counter for running jobs
  let now = $state(Date.now());

  $effect(() => {
    if (!open || !jobsStore.hasRunningJobs) return;
    const intervalId = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(intervalId);
  });

  function formatElapsed(job: Job): string {
    const end = job.endTime ?? now;
    const seconds = Math.floor((end - job.startTime) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  }

  function truncateDetail(detail: string, maxLen: number = 60): string {
    return detail.length > maxLen ? detail.slice(0, maxLen) + "..." : detail;
  }

</script>

<Modal
  {open}
  {onClose}
  overlayClass="panel-overlay"
  labelledby="jobs-panel-title"
>
    <div class="panel" tabindex="-1" bind:this={panel}>
      <header class="panel-header">
        <h2 id="jobs-panel-title">Background Jobs</h2>
        <div class="header-actions">
          <button class="clear-btn" onclick={() => { unresolvedOpen = true; }}>Unresolved AI operations</button>
          <button class="clear-btn" onclick={() => jobsStore.refreshNative()}>Reload job status</button>
          {#if jobsStore.jobs.some((j) => !isJobActive(j))}
            <button class="clear-btn" onclick={() => jobsStore.clearCompleted()}>
              Clear Completed
            </button>
          {/if}
          <button class="close-btn" onclick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </header>

      <div class="panel-body">
        {#if jobsStore.monitoringError}<p role="alert">{jobsStore.monitoringError}</p>{/if}
        {#if jobsStore.jobs.length === 0}
          <div class="empty-state">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="4" y="6" width="24" height="20" rx="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M4 12H28" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="8" cy="9" r="1" fill="currentColor"/>
              <circle cx="12" cy="9" r="1" fill="currentColor"/>
              <circle cx="16" cy="9" r="1" fill="currentColor"/>
            </svg>
            <p>No background jobs</p>
          </div>
        {:else}
          <div class="job-list">
            {#each jobsStore.jobs as job (job.jobKey ?? `${job.source}:${job.id}`)}
              <div class="job-item" class:completed={job.status === "completed"} class:error={job.status === "error"} data-job-id={job.id} tabindex="-1">
                <div class="job-status">
                  {#if job.status === "running"}
                    <div class="spinner"></div>
                  {:else if job.status === "completed"}
                    <svg class="status-icon success" width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8L6.5 11.5L13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {:else if job.status === "error"}
                    <svg class="status-icon error" width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                  {:else}<span aria-hidden="true">{isJobActive(job) ? "○" : "−"}</span>
                  {/if}
                </div>
                <div class="job-details">
                  <div class="job-label">{job.label}</div>
                  <div class="job-prompt">{truncateDetail(job.detail)}</div>
                  {#if job.jobKey}<div class="job-phase" role="status">{job.status === "running" || job.status === "accepting" ? job.phase ?? jobStateLabel(job.status) : jobStateLabel(job.status)}{job.cancelRequested ? " · cancellation requested" : ""}</div>{/if}
                  {#if job.controlError}<div class="job-error" role="alert">{job.controlError}</div>{/if}
                  {#if job.status === "error" && job.error}
                    <div class="job-error">{job.error}</div>
                  {/if}
                  {#if job.status === "completed" && job.outputPath}
                    <div class="job-output">{basename(job.outputPath)}</div>
                  {/if}
                </div>
                <div class="job-time">{formatElapsed(job)}</div>
                {#if job.jobKey && ["accepting", "running", "recovering"].includes(job.status)}<button class="clear-btn" aria-label={`Cancel ${job.label}`} disabled={!!job.controlPending || job.cancelRequested} onclick={() => jobsStore.controlJob(job.id, "cancel")}>{job.cancelRequested ? "Cancel requested" : "Cancel"}</button>{/if}
                {#if job.jobKey && job.status === "needs_attention"}<button class="clear-btn" onclick={() => { unresolvedOpen = true; }}>Inspect operation</button>{/if}
                {#if job.jobKey && job.status === "needs_attention" && !isJobActive(job)}<button class="clear-btn" aria-label={`Dismiss ${job.label}`} disabled={!!job.controlPending} onclick={() => jobsStore.dismissJob(job.id)}>Dismiss</button>{/if}
                {#if job.status === "error" && job.retry}
                  <button class="clear-btn retry-btn" aria-label={`Retry ${job.label}`} disabled={job.retrying || !!job.controlPending}
                    aria-busy={job.retrying} onclick={() => void retryJobAndRefocus(job.id, panel)}>Retry</button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
</Modal>
{#if unresolvedOpen}<AiOperationsDialog onClose={() => { unresolvedOpen = false; }} />{/if}

<style>
  .panel {
    width: 520px;
    max-width: 90vw;
    max-height: 70vh;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    animation: slideUp 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider);
  }

  .panel-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .clear-btn {
    padding: 4px 12px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .clear-btn:hover {
    background: var(--control-fill-secondary);
    color: var(--text-primary);
  }

  .clear-btn:disabled {
    opacity: 0.5;
    cursor: default;
    background: var(--control-fill);
    color: var(--text-secondary);
  }

  .retry-btn {
    flex-shrink: 0;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .close-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 20px;
    color: var(--text-tertiary);
  }

  .empty-state p {
    font-size: 14px;
  }

  .job-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .job-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px;
    border-radius: var(--radius-sm);
    background: var(--subtle-fill);
    transition: background var(--transition-fast);
  }

  .job-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .job-status {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 1px;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--text-tertiary);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .status-icon.success {
    color: var(--system-success-text, var(--system-success, #4caf50));
  }

  .status-icon.error {
    color: var(--system-critical-text, var(--system-critical));
  }

  .job-details {
    flex: 1;
    min-width: 0;
  }

  .job-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-prompt {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-error {
    font-size: 11px;
    color: var(--system-critical-text, var(--system-critical));
    margin-top: 4px;
    word-break: break-word;
  }
  .job-phase { font-size: 12px; color: var(--text-secondary); margin-top: 4px; overflow-wrap: anywhere; }
  @media (max-width: 600px) { .panel-header { flex-wrap: wrap; gap: 8px; } .header-actions { flex-wrap: wrap; } .job-item { flex-wrap: wrap; } .job-details { flex-basis: 50%; } }

  .job-output {
    font-size: 11px;
    color: var(--system-success-text, var(--system-success, #4caf50));
    margin-top: 4px;
  }

  .job-time {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  /* Focus lands here after a successful Retry (the button goes with its entry). */
  .job-item:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }
</style>
