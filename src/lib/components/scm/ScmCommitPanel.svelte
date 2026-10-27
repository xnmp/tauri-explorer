<!--
  ScmCommitPanel — branch line with the flat/tree view toggle, commit
  message (Enter commits, Ctrl/Cmd+Enter amends, Shift+Enter is a newline),
  inline commit error, Amend toggle and the Commit button.
-->
<script lang="ts">
  import type { ScmStore } from "$lib/state/scm.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";

  interface Props {
    scmStore: ScmStore;
    /** The (filtered) summary's branch line. */
    summary: { branch: string | null; detached: boolean };
    canCommit: boolean;
    onCommit: (opts?: { forceAmend?: boolean }) => void;
  }

  const { scmStore, summary, canCommit, onCommit }: Props = $props();

  const commitMode = $derived.by(() => {
    if (scmStore.amend) return "amend";
    return "commit";
  });

  const commitButtonLabel = $derived(
    commitMode === "amend" ? "Commit (Amend)" : "Commit"
  );

  const commitButtonTooltip = $derived(
    commitMode === "amend"
      ? "Amend the previous commit using this message"
      : "Create a new commit (Ctrl+Enter with empty message to amend)"
  );

  const doCommit = (opts?: { forceAmend?: boolean }) => onCommit(opts);

  function onCommitKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      if (e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      doCommit({ forceAmend: e.ctrlKey || e.metaKey });
    }
  }
</script>

<div class="commit-panel">
  <div class="branch-line">
    <span class="branch-icon" aria-hidden="true">⌥</span>
    {#if summary.detached}
      <span class="branch-name detached" title="detached HEAD">HEAD@{summary.branch}</span>
    {:else}
      <span class="branch-name">{summary.branch ?? "main"}</span>
    {/if}
    <button
      type="button"
      class="view-toggle"
      aria-pressed={settingsStore.scmTreeView}
      title={settingsStore.scmTreeView ? "Switch to flat list" : "Switch to tree view"}
      onclick={() => settingsStore.toggleScmTreeView()}
    >
      {settingsStore.scmTreeView ? "Tree" : "List"}
    </button>
  </div>
  <textarea
    class="commit-message"
    placeholder={scmStore.amend
      ? "Amend commit message (optional)"
      : "Message (Enter to commit, Ctrl+Enter to amend)"}
    value={scmStore.commitMessage}
    oninput={(e) => scmStore.setCommitMessage((e.target as HTMLTextAreaElement).value)}
    onkeydown={onCommitKeydown}
    rows="2"
    aria-label="Commit message"
  ></textarea>
  {#if scmStore.commitError}
    <div class="commit-error" role="alert">{scmStore.commitError}</div>
  {/if}
  <div class="commit-row">
    <label class="amend-toggle">
      <input
        type="checkbox"
        checked={scmStore.amend}
        onchange={(e) => scmStore.setAmend((e.target as HTMLInputElement).checked)}
      />
      <span>Amend</span>
    </label>
    <button
      type="button"
      class="commit-btn"
      disabled={!canCommit}
      onclick={() => doCommit()}
      title={commitButtonTooltip}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="commit-btn-icon">
        <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      {commitButtonLabel}
    </button>
  </div>
</div>

<style>
  .commit-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--divider);
  }

  .branch-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
    font-weight: var(--font-weight-semibold);
  }

  .branch-name {
    color: var(--text-secondary);
    text-transform: none;
    letter-spacing: var(--letter-spacing-normal);
  }

  .branch-name.detached {
    color: var(--system-warning, #f59e0b);
  }

  .view-toggle {
    margin-left: auto;
    padding: 2px 8px;
    background: var(--background-card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .view-toggle:hover {
    background: var(--subtle-fill-secondary);
  }

  .view-toggle[aria-pressed="true"] {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent-text, var(--accent));
    border-color: var(--accent);
  }

  .commit-message {
    width: 100%;
    min-height: 52px;
    padding: 8px 10px;
    background: var(--control-fill);
    border: 1px solid var(--divider);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
    transition: border-color var(--transition-fast);
  }

  .commit-message::placeholder {
    color: var(--text-tertiary);
  }

  .commit-message:focus {
    outline: none;
    border-color: var(--accent);
  }

  .commit-error {
    font-size: 11px;
    color: var(--system-critical-text, var(--system-critical, #dc2626));
    padding: 2px 4px;
  }

  .commit-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .amend-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }

  .amend-toggle input {
    accent-color: var(--accent);
  }

  .commit-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    height: 26px;
    padding: 0 14px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity var(--transition-fast), background var(--transition-fast);
  }

  .commit-btn-icon {
    flex-shrink: 0;
  }

  .commit-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, black);
  }

  .commit-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
