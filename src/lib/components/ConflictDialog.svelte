<!--
  ConflictDialog component - File conflict resolution during paste
  Issue: tauri-zqdp
-->
<script lang="ts">
  import { conflictResolver, type ConflictChoice } from "$lib/state/conflict-resolver.svelte";

  const conflict = $derived(conflictResolver.activeConflict);

  function handleChoice(choice: ConflictChoice, applyToAll = false): void {
    conflictResolver.resolve(choice, applyToAll);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!conflict) return;
    if (event.key === "Escape") {
      handleChoice("cancel");
    }
  }
</script>

{#if conflict}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="conflict-overlay" onkeydown={handleKeydown}>
    <div class="conflict-dialog" role="alertdialog" aria-label="File conflict">
      <div class="conflict-header">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L22 20H2L12 2Z" stroke="var(--system-caution)" stroke-width="1.5" fill="var(--system-caution)" fill-opacity="0.15"/>
          <path d="M12 10V14M12 17V16" stroke="var(--system-caution)" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <h3>File already exists</h3>
      </div>

      <p class="conflict-message">
        <strong>{conflict.fileName}</strong> already exists in this folder.
      </p>

      <div class="conflict-actions">
        <button class="btn btn-primary" onclick={() => handleChoice("overwrite")}>
          Replace
        </button>
        <button class="btn" onclick={() => handleChoice("skip")}>
          Skip
        </button>
        {#if conflict.remaining > 0}
          <div class="separator"></div>
          <button class="btn btn-primary" onclick={() => handleChoice("overwrite", true)}>
            Replace All ({conflict.remaining + 1})
          </button>
          <button class="btn" onclick={() => handleChoice("skip", true)}>
            Skip All ({conflict.remaining + 1})
          </button>
        {/if}
        <div class="separator"></div>
        <button class="btn btn-cancel" onclick={() => handleChoice("cancel")}>
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .conflict-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .conflict-dialog {
    background: var(--background-solid);
    border: 1px solid var(--divider);
    border-radius: 8px;
    padding: 24px;
    min-width: 380px;
    max-width: 480px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  .conflict-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }

  .conflict-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .conflict-message {
    margin: 0 0 20px;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    word-break: break-word;
  }

  .conflict-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .separator {
    width: 100%;
    height: 0;
  }

  .btn {
    padding: 6px 16px;
    border: 1px solid var(--divider);
    border-radius: 4px;
    background: var(--control-fill);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 120ms ease;
  }

  .btn:hover {
    background: var(--subtle-fill-secondary);
  }

  .btn-primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-cancel {
    color: var(--text-secondary);
  }
</style>
