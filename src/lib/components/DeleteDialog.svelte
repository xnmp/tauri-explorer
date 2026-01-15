<!--
  DeleteDialog component - Windows 11 Fluent Design
  Issue: tauri-explorer-h3n, tauri-explorer-w0eo
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";

  let error = $state<string | null>(null);
  let deleting = $state(false);

  async function handleConfirm() {
    deleting = true;
    error = null;

    const result = await explorer.confirmDelete();

    deleting = false;

    if (result) {
      error = result;
    }
  }

  function handleCancel() {
    error = null;
    explorer.cancelDelete();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      handleCancel();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  }
</script>

{#if explorer.state.deletingEntry}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="overlay"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    aria-describedby="dialog-description"
    tabindex="-1"
    onkeydown={handleKeydown}
    onclick={handleBackdropClick}
  >
    <div class="dialog">
      <div class="dialog-icon">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2"/>
          <path d="M16 9V18M16 23V21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      </div>

      <div class="dialog-content">
        <h2 id="dialog-title">Delete {explorer.state.deletingEntry.kind === "directory" ? "folder" : "file"}?</h2>

        <p id="dialog-description" class="message">
          <strong>{explorer.state.deletingEntry.name}</strong> will be moved to the Recycle Bin.
          {#if explorer.state.deletingEntry.kind === "directory"}
            <span class="info">All files and folders inside will also be moved.</span>
          {/if}
        </p>

        {#if error}
          <p class="error-message" role="alert">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.25"/>
              <path d="M6 3.5V6.5M6 8.5V8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
            </svg>
            {error}
          </p>
        {/if}
      </div>

      <div class="dialog-actions">
        <button type="button" class="btn secondary" onclick={handleCancel} disabled={deleting}>
          Cancel
        </button>
        <button type="button" class="btn danger" onclick={handleConfirm} disabled={deleting}>
          {#if deleting}
            <span class="spinner"></span>
          {/if}
          Delete
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: overlayIn 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes overlayIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .dialog {
    background: var(--background-acrylic);
    backdrop-filter: blur(60px) saturate(125%);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-lg);
    padding: var(--spacing-xl);
    min-width: 360px;
    max-width: 420px;
    box-shadow: var(--shadow-dialog);
    animation: dialogIn 250ms cubic-bezier(0.1, 0.9, 0.2, 1);
  }

  @keyframes dialogIn {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .dialog-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    margin: 0 auto var(--spacing-lg);
    color: var(--system-critical);
    animation: iconPulse 600ms ease-out;
  }

  @keyframes iconPulse {
    0% { transform: scale(0.8); opacity: 0; }
    50% { transform: scale(1.05); }
    100% { transform: scale(1); opacity: 1; }
  }

  .dialog-content {
    text-align: center;
    margin-bottom: var(--spacing-xl);
  }

  .dialog-content h2 {
    margin: 0 0 var(--spacing-sm);
    font-size: var(--font-size-subtitle);
    font-weight: 600;
    color: var(--text-primary);
  }

  .message {
    margin: 0;
    font-size: var(--font-size-body);
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .message strong {
    color: var(--text-primary);
    word-break: break-all;
  }

  .info {
    display: block;
    margin-top: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.08), rgba(0, 120, 212, 0.04));
    border: 1px solid rgba(0, 120, 212, 0.15);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
  }

  .error-message {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-xs);
    margin: var(--spacing-md) 0 0;
    font-size: var(--font-size-caption);
    color: var(--system-critical);
    animation: shake 300ms ease-out;
  }

  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-4px); }
    40%, 80% { transform: translateX(4px); }
  }

  .dialog-actions {
    display: flex;
    justify-content: center;
    gap: var(--spacing-sm);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm);
    min-width: 100px;
    padding: 8px var(--spacing-lg);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-body);
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn.secondary {
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    color: var(--text-primary);
  }

  .btn.secondary:hover:not(:disabled) {
    background: var(--control-fill-secondary);
  }

  .btn.secondary:active:not(:disabled) {
    background: var(--control-fill-tertiary);
  }

  .btn.danger {
    background: var(--system-critical);
    border: 1px solid transparent;
    color: white;
  }

  .btn.danger:hover:not(:disabled) {
    background: #a61b0f;
  }

  .btn.danger:active:not(:disabled) {
    background: #8a1610;
    transform: scale(0.98);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 600ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-color-scheme: dark) {
    .overlay {
      background: rgba(0, 0, 0, 0.5);
    }

    .btn.danger {
      background: #dc3545;
    }

    .btn.danger:hover:not(:disabled) {
      background: #c82333;
    }
  }
</style>
