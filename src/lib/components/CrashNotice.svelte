<!--
  Crash notice banner (#184). Shown once after a crash, or after a session
  that did not exit cleanly (#1686, `session_marker.rs`): offers to report it
  through the Report Issue dialog (#1684), where the crash file is a
  previewed, opt-in section sent through the relay (no GitHub account
  needed), or to dismiss it.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { takeCrashReport } from "$lib/api/crash";
  import { crashNoticeLead } from "$lib/domain/crash-report";
  import { claimLaunchCrash, crashReportStore } from "$lib/state/crash-report.svelte";
  import { warmMode } from "$lib/state/page-foreground";

  const report = $derived(crashReportStore.offered);

  onMount(() => {
    claimLaunchCrash(crashReportStore, takeCrashReport, warmMode() === "off").catch(() => {
      // Crash lookup failing must never break startup.
    });
  });

  // Lazy: the report draft store stays out of the startup bundle.
  function reportCrash(): void {
    void import("$lib/state/crash-reporting")
      .then(({ reportOfferedCrash }) => reportOfferedCrash())
      .catch(() => {
        // Keep the offer visible rather than losing the crash on a failed load.
      });
  }
</script>

{#if report}
  <div class="crash-notice" role="alert" data-testid="crash-notice">
    <span class="crash-message">
      {crashNoticeLead(report.kind)}
      <code>{report.fileName}</code> — nothing was sent anywhere.
    </span>
    <div class="crash-actions">
      <button class="crash-report-btn" onclick={reportCrash}>Report…</button>
      <button class="crash-dismiss-btn" onclick={() => crashReportStore.dismiss()}>Dismiss</button>
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
