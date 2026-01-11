<!--
  DeleteDialog component - confirmation dialog for deleting files/folders.
  Issue: tauri-explorer-h3n
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
</script>

{#if explorer.state.deletingEntry}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
  <div class="overlay" role="dialog" aria-modal="true" tabindex="-1" onkeydown={handleKeydown}>
    <div class="dialog">
      <h2>Delete</h2>

      <p class="message">
        Are you sure you want to delete
        <strong>{explorer.state.deletingEntry.name}</strong>?
        {#if explorer.state.deletingEntry.kind === "directory"}
          <br /><span class="warning">This will delete all contents inside the folder.</span>
        {/if}
      </p>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="actions">
        <button type="button" onclick={handleCancel} disabled={deleting}>
          Cancel
        </button>
        <button type="button" class="danger" onclick={handleConfirm} disabled={deleting}>
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: var(--background, #fff);
    border-radius: 8px;
    padding: 20px;
    min-width: 300px;
    max-width: 400px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  }

  h2 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
  }

  .message {
    margin: 0 0 16px 0;
    font-size: 14px;
    line-height: 1.5;
  }

  .warning {
    color: var(--error, #d32f2f);
    font-size: 12px;
  }

  .error {
    color: var(--error, #d32f2f);
    font-size: 12px;
    margin: 0 0 8px 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  button {
    padding: 6px 16px;
    border: 1px solid var(--border, #e0e0e0);
    border-radius: 4px;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    background: transparent;
  }

  button:hover:not(:disabled) {
    background: var(--hover-bg, rgba(0, 0, 0, 0.04));
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.danger {
    background: var(--error, #d32f2f);
    color: white;
    border-color: var(--error, #d32f2f);
  }

  button.danger:hover:not(:disabled) {
    background: #b71c1c;
  }
</style>
