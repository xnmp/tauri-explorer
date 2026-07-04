<!--
  First-run hint (#186). Shown once, ever: points brand-new users at the
  keyboard-first workflow before they go hunting through menus.
-->
<script lang="ts">
  import { dialogStore } from "$lib/state/dialogs.svelte";

  const DISMISSED_KEY = "firstRunHintDismissed";

  let visible = $state(
    typeof localStorage !== "undefined" && localStorage.getItem(DISMISSED_KEY) !== "1"
  );

  function dismiss(): void {
    localStorage.setItem(DISMISSED_KEY, "1");
    visible = false;
  }

  function showShortcuts(): void {
    dismiss();
    dialogStore.openShortcuts();
  }
</script>

{#if visible}
  <div class="first-run-hint" role="status" data-testid="first-run-hint">
    <span>
      Everything here is a keystroke away: <kbd>Ctrl+P</kbd> opens files,
      <kbd>Ctrl+Shift+P</kbd> runs any command.
    </span>
    <div class="hint-actions">
      <button class="hint-shortcuts-btn" onclick={showShortcuts}>View shortcuts</button>
      <button onclick={dismiss}>Got it</button>
    </div>
  </div>
{/if}

<style>
  .first-run-hint {
    position: fixed;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999;
    display: flex;
    align-items: center;
    gap: 16px;
    max-width: min(680px, calc(100vw - 32px));
    padding: 10px 16px;
    border-radius: 8px;
    background: var(--background-card, #fff);
    border: 1px solid var(--border-color, #ddd);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    font-size: 13px;
    color: var(--text-primary, #222);
  }

  kbd {
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #ccc);
    background: var(--background-secondary, #f5f5f5);
    font-family: inherit;
    font-size: 11px;
  }

  .hint-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .hint-actions button {
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border-color, #ccc);
    background: var(--background-secondary, #f5f5f5);
    color: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .hint-shortcuts-btn {
    background: var(--accent-color, #0078d4);
    border-color: var(--accent-color, #0078d4);
    color: #fff;
  }
</style>
