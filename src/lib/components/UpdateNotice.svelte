<!--
  Update notice banner (#185). After startup settles, checks (at most once a
  day) whether a newer GitHub release exists and offers to open it.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import "./modal.css";
  import {
    checkForUpdate,
    markUpdateChecked,
    shouldCheckForUpdate,
    type UpdateInfo,
  } from "$lib/api/update";
  import { openExternalUrl } from "$lib/api/crash";
  import "./modal.css";

  /** Delay so the check never competes with startup work. */
  const STARTUP_DELAY_MS = 5000;

  let update = $state<UpdateInfo | null>(null);

  onMount(() => {
    const timer = setTimeout(() => {
      if (!shouldCheckForUpdate()) return;
      markUpdateChecked();
      checkForUpdate()
        .then((u) => (update = u))
        .catch(() => {
          // Offline or rate-limited — try again another day.
        });
    }, STARTUP_DELAY_MS);
    return () => clearTimeout(timer);
  });

  function viewRelease(): void {
    if (!update) return;
    void openExternalUrl(update.url).catch(() => {});
    update = null;
  }
</script>

{#if update}
  <div class="update-notice modal-card" role="status" data-testid="update-notice">
    <span>Tauri Explorer {update.version} is available.</span>
    <div class="update-actions dialog-actions">
      <button type="button" class="btn primary" onclick={viewRelease}>View release</button>
      <button type="button" class="btn secondary" onclick={() => (update = null)}>Dismiss</button>
    </div>
  </div>
{/if}

<style>
  .update-notice {
    position: fixed;
    bottom: 40px;
    right: 16px;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: var(--spacing-lg);
    color: var(--text-primary);
  }

  .update-actions {
    display: flex;
    gap: var(--spacing-sm);
    flex-shrink: 0;
    margin-top: 0;
  }
</style>
