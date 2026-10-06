<script lang="ts">
  import { getAppInfo, type AppInfo } from "$lib/api/crash";
  import Modal from "./Modal.svelte";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();
  let info = $state<AppInfo | null>(null);
  let failed = $state(false);

  $effect(() => {
    if (!open) return;
    info = null;
    failed = false;
    let active = true;
    void getAppInfo().then(
      (result) => { if (active) info = result; },
      () => { if (active) failed = true; },
    );
    return () => { active = false; };
  });
</script>

<Modal {open} {onClose} label="About Tauri Explorer">
  <div class="about-dialog modal-card">
    <div class="dialog-header">
      <h2>Tauri Explorer</h2>
      <p class="dialog-subtitle">A minimalistic, high-performance file explorer</p>
    </div>
    <p class="version" aria-live="polite">
      {#if info}Version {info.version}
      {:else if failed}Unable to load version information.
      {:else}Loading version…{/if}
    </p>
    <div class="dialog-actions">
      <button class="btn secondary" data-autofocus onclick={onClose}>Close</button>
    </div>
  </div>
</Modal>

<style>
  .version {
    margin: 0;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
</style>
