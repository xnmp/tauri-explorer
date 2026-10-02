<script lang="ts">
  import Modal from "./Modal.svelte";
  import KeybindingsSettings from "./KeybindingsSettings.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();
</script>

<Modal {open} {onClose} labelledby="keybindings-title">
  <div class="keybindings-dialog" style:--settings-zoom={settingsStore.zoomLevel / 100}>
    <header>
      <div>
        <h2 id="keybindings-title">Keyboard Shortcuts</h2>
        <p>Choose a binding to change it. Press Escape to cancel recording.</p>
      </div>
      <button class="close-btn" onclick={onClose} aria-label="Close keyboard shortcuts">×</button>
    </header>
    <div class="dialog-content">
      {#if open}<KeybindingsSettings />{/if}
    </div>
  </div>
</Modal>

<style>
  .keybindings-dialog {
    width: 680px;
    max-width: calc((100vw - 32px) / var(--settings-zoom, 1));
    max-height: calc((100vh - 32px) / var(--settings-zoom, 1));
    display: flex;
    flex-direction: column;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-dialog);
    overflow: hidden;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    padding: 20px;
    border-bottom: 1px solid var(--divider);
    flex-shrink: 0;
  }
  h2 { margin: 0; font-size: 18px; color: var(--text-primary); }
  p { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); }
  .close-btn {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 24px;
    cursor: pointer;
  }
  .close-btn:hover { background: var(--subtle-fill-secondary); }
  .close-btn:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .dialog-content { min-height: 0; overflow: auto; padding: 20px; }
</style>
