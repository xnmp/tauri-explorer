<!--
  NewFolderDialog component - Windows 11 Fluent Design
  Issue: tauri-explorer-jql, tauri-explorer-1k9k
-->
<script lang="ts">
  import { explorer as defaultExplorer, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";

  interface Props {
    explorer?: ExplorerInstance;
  }

  let { explorer = defaultExplorer }: Props = $props();

  let folderName = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  async function handleSubmit(event: Event) {
    event.preventDefault();

    if (!folderName.trim()) {
      error = "Folder name cannot be empty";
      return;
    }

    submitting = true;
    error = null;

    const result = await explorer.createFolder(folderName.trim());

    submitting = false;

    if (result) {
      error = result;
    } else {
      folderName = "";
    }
  }

  function handleCancel() {
    folderName = "";
    error = null;
    dialogStore.closeNewFolder();
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

{#if dialogStore.isNewFolderOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    tabindex="-1"
    onkeydown={handleKeydown}
    onclick={handleBackdropClick}
  >
    <div class="dialog">
      <div class="dialog-header">
        <h2 id="dialog-title">New folder</h2>
      </div>

      <form onsubmit={handleSubmit}>
        <div class="form-field">
          <label for="folder-name">Name</label>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            id="folder-name"
            type="text"
            bind:value={folderName}
            placeholder="Untitled folder"
            disabled={submitting}
            autofocus
            class:error={!!error}
          />
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
          <button type="button" class="btn secondary" onclick={handleCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={submitting || !folderName.trim()}>
            {#if submitting}
              <span class="spinner"></span>
            {/if}
            Create
          </button>
        </div>
      </form>
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
    max-width: 480px;
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

  .dialog-header {
    margin-bottom: var(--spacing-lg);
  }

  .dialog-header h2 {
    margin: 0;
    font-size: var(--font-size-subtitle);
    font-weight: 600;
    color: var(--text-primary);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  label {
    font-size: var(--font-size-caption);
    font-weight: 500;
    color: var(--text-primary);
  }

  input {
    width: 100%;
    padding: 10px var(--spacing-md);
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-bottom-width: 2px;
    border-bottom-color: var(--control-stroke-secondary);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-body);
    font-family: inherit;
    color: var(--text-primary);
    transition: all var(--transition-fast);
  }

  input::placeholder {
    color: var(--text-tertiary);
  }

  input:hover:not(:disabled) {
    background: var(--control-fill-secondary);
  }

  input:focus {
    outline: none;
    background: var(--control-fill);
    border-color: var(--accent);
    border-bottom-color: var(--accent);
  }

  input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  input.error {
    border-color: var(--system-critical);
    border-bottom-color: var(--system-critical);
  }

  .error-message {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    margin: 0;
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
    justify-content: flex-end;
    gap: var(--spacing-sm);
    margin-top: var(--spacing-xl);
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

  .btn.primary {
    background: var(--accent);
    border: 1px solid transparent;
    color: var(--text-on-accent);
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--accent-dark);
  }

  .btn.primary:active:not(:disabled) {
    background: var(--accent-dark);
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
  }
</style>
