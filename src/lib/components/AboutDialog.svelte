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
    {#if info?.environment?.length}
      <dl class="environment" aria-label="Environment">
        {#each info.environment as field (field.label)}
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        {/each}
      </dl>
    {/if}
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

  .environment {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 12px;
    margin: 8px 0 0;
    font-size: 12px;
    user-select: text;
  }

  .environment dt {
    color: var(--text-secondary);
  }

  .environment dd {
    margin: 0;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
</style>
