<!--
  GitHubReportTokenSetting — optional GitHub personal access token for
  Report Issue (#1455). The token is write-only: it is stored in the OS
  credential store and never read back, so this shows only whether one is
  saved.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { reportTokenStore } from "$lib/state/report-token.svelte";

  interface Props {
    hidden: boolean;
  }

  const { hidden }: Props = $props();
  let draft = $state("");

  onMount(() => { void reportTokenStore.refresh(); });

  const status = $derived(
    reportTokenStore.state === "configured"
      ? "A token is saved. Text-only reports are created by your GitHub account."
      : reportTokenStore.state === "unavailable"
        ? "OS credential storage is unavailable or locked, so reports are sent anonymously."
        : "No token saved. Reports are sent anonymously through the Tauri Explorer report service.",
  );

  async function save(): Promise<void> {
    if (await reportTokenStore.save(draft)) draft = "";
  }
</script>

<div class="github-token-setting" class:hidden>
  <div class="setting-info">
    <span class="setting-label">GitHub Token for Reports</span>
    <span class="setting-description">
      Optional. Paste a GitHub personal access token to file Report Issue submissions as
      yourself in xnmp/tauri-explorer instead of anonymously. A fine-grained token needs
      public repository access with Issues: write; a classic token needs public_repo.
      Reports with images or videos still go through the anonymous report service.
      The token is kept in your OS credential store and never shown again.
    </span>
  </div>
  <p class="status" role="status">{status}</p>
  <form class="token-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <input
      type="password"
      class="token-input"
      aria-label="GitHub personal access token"
      autocomplete="off"
      spellcheck="false"
      placeholder={reportTokenStore.state === "configured" ? "Paste a new token to replace it" : "github_pat_… or ghp_…"}
      bind:value={draft}
      disabled={reportTokenStore.busy}
    />
    <button type="submit" class="token-button" disabled={reportTokenStore.busy || !draft.trim()}>
      {reportTokenStore.state === "configured" ? "Replace" : "Save"}
    </button>
    <button
      type="button"
      class="token-button"
      disabled={reportTokenStore.busy || reportTokenStore.state !== "configured"}
      onclick={() => { draft = ""; void reportTokenStore.clear(); }}
    >Remove</button>
  </form>
  {#if reportTokenStore.error}
    <p class="error" role="alert">{reportTokenStore.error}</p>
  {/if}
</div>

<style>
  .hidden {
    display: none !important;
  }

  .github-token-setting {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .setting-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .setting-description, .status {
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0;
  }

  .status { color: var(--text-secondary); }

  .token-form {
    display: flex;
    gap: 8px;
  }

  .token-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text-primary);
    font: inherit;
    font-size: 13px;
  }

  .token-button {
    padding: 6px 12px;
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text-primary);
    font-size: 13px;
  }

  .token-button:disabled { opacity: 0.5; }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--system-critical-text, var(--system-critical));
  }
</style>
