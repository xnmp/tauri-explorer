<!--
  RenameDialog component - dialog for renaming files/folders.
  Issue: tauri-explorer-bae
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";

  let newName = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  // Initialize with current name when dialog opens
  $effect(() => {
    if (explorer.state.renamingEntry) {
      newName = explorer.state.renamingEntry.name;
      error = null;
    }
  });

  async function handleSubmit(event: Event) {
    event.preventDefault();

    if (!newName.trim()) {
      error = "Name cannot be empty";
      return;
    }

    if (newName.trim() === explorer.state.renamingEntry?.name) {
      // No change, just close
      explorer.cancelRename();
      return;
    }

    submitting = true;
    error = null;

    const result = await explorer.rename(newName.trim());

    submitting = false;

    if (result) {
      error = result;
    }
  }

  function handleCancel() {
    newName = "";
    error = null;
    explorer.cancelRename();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      handleCancel();
    }
  }
</script>

{#if explorer.state.renamingEntry}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
  <div class="overlay" role="dialog" aria-modal="true" tabindex="-1" onkeydown={handleKeydown}>
    <div class="dialog">
      <h2>Rename</h2>

      <form onsubmit={handleSubmit}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          bind:value={newName}
          placeholder="New name"
          disabled={submitting}
          autofocus
        />

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <div class="actions">
          <button type="button" onclick={handleCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={submitting || !newName.trim()}>
            {submitting ? "Renaming..." : "Rename"}
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
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  }

  h2 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
  }

  input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border, #e0e0e0);
    border-radius: 4px;
    font-size: 14px;
    font-family: inherit;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: var(--focus-ring, #0078d4);
  }

  .error {
    color: var(--error, #d32f2f);
    font-size: 12px;
    margin: 8px 0 0 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
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

  button.primary {
    background: var(--focus-ring, #0078d4);
    color: white;
    border-color: var(--focus-ring, #0078d4);
  }

  button.primary:hover:not(:disabled) {
    background: #106ebe;
  }
</style>
