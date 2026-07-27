<!--
  Crash notice banner (#184). Shown once after a crash: offers to open a
  pre-filled GitHub issue with the local crash report, or dismiss.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import {
    takeCrashReport,
    crashIssueUrl,
    openExternalUrl,
    type CrashReport,
  } from "$lib/api/crash";

  let report = $state<CrashReport | null>(null);

  onMount(() => {
    takeCrashReport()
      .then((r) => (report = r))
      .catch(() => {
        // Crash lookup failing must never break startup.
      });
  });

  function reportOnGitHub(): void {
    if (!report) return;
    void openExternalUrl(crashIssueUrl(report)).catch(() => {});
    report = null;
  }
</script>

{#if report}
  <div class="crash-notice" role="alert" data-testid="crash-notice">
    <span class="crash-message">
      Tauri Explorer crashed last time. A report was saved locally to
      <code>{report.fileName}</code> — nothing was sent anywhere.
    </span>
    <div class="crash-actions">
      <button class="crash-report-btn" onclick={reportOnGitHub}>Report on GitHub</button>
      <button class="crash-dismiss-btn" onclick={() => (report = null)}>Dismiss</button>
    </div>
  </div>
{/if}

<style>
  .crash-notice {
    position: fixed;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 16px;
    max-width: min(720px, calc(100vw - 32px));
    padding: 10px 16px;
    border-radius: 8px;
    /* This notice must remain readable over animated/translucent app surfaces. */
    background: var(--background-solid, #1e1e1e);
    border: 1px solid var(--surface-stroke);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    font-size: 13px;
    color: var(--text-primary, #222);
  }

  .crash-message code {
    font-size: 12px;
  }

  .crash-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .crash-actions button {
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--control-stroke);
    background: var(--control-fill);
    color: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .crash-report-btn {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--text-on-accent);
  }
</style>
