<!--
  Update notice banner (#185). After startup settles, checks (at most once a
  day) whether a newer GitHub release exists and offers to open it.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import {
    checkForUpdate,
    markUpdateChecked,
    shouldCheckForUpdate,
    type UpdateInfo,
  } from "$lib/api/update";
  import { openExternalUrl } from "$lib/api/crash";

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
  <div class="update-notice" role="status" data-testid="update-notice">
    <span>Tauri Explorer {update.version} is available.</span>
    <div class="update-actions">
      <button class="update-view-btn" onclick={viewRelease}>View release</button>
      <button onclick={() => (update = null)}>Dismiss</button>
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
    gap: 14px;
    padding: 8px 14px;
    border-radius: 8px;
    background: var(--background-card, #fff);
    border: 1px solid var(--border-color, #ddd);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    font-size: 13px;
    color: var(--text-primary, #222);
  }

  .update-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .update-actions button {
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border-color, #ccc);
    background: var(--background-secondary, #f5f5f5);
    color: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .update-view-btn {
    background: var(--accent-color, #0078d4);
    border-color: var(--accent-color, #0078d4);
    color: #fff;
  }
</style>
