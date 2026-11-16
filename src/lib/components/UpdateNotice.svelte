<!--
  Update notice (#185, #1679). After startup settles, checks (at most once a
  day) for a newer release. With automatic updates on and a self-updatable
  install, the backend has already downloaded it: offer a restart into it.
  Otherwise offer to open the release page.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import "./modal.css";
  import {
    installUpdate,
    markUpdateChecked,
    prepareUpdate,
    shouldCheckForUpdate,
    type UpdateOffer,
  } from "$lib/api/update";
  import { openExternalUrl } from "$lib/api/crash";
  import { extractError } from "$lib/api/common";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { toastStore } from "$lib/state/toast.svelte";

  /** Delay so the check never competes with startup work. */
  const STARTUP_DELAY_MS = 5000;

  let update = $state<UpdateOffer | null>(null);
  let installing = $state(false);

  onMount(() => {
    const timer = setTimeout(() => {
      if (!shouldCheckForUpdate()) return;
      markUpdateChecked();
      prepareUpdate(settingsStore.autoUpdate)
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

  async function restartNow(): Promise<void> {
    installing = true;
    try {
      // Resolves only if the relaunch is deferred to the normal exit path;
      // on Windows the installer takes over the process.
      await installUpdate();
    } catch (error) {
      installing = false;
      toastStore.error(`Could not install the update: ${extractError(error)}`);
    }
  }
</script>

{#if update}
  <div class="update-notice modal-card" role="status" data-testid="update-notice" data-ready={update.ready}>
    {#if update.ready}
      <span>Tauri Explorer {update.version} is ready to install.</span>
      <div class="update-actions dialog-actions">
        <button type="button" class="btn primary" onclick={restartNow} disabled={installing}>
          {installing ? "Restarting…" : "Restart now"}
        </button>
        <button type="button" class="btn secondary" onclick={() => (update = null)} disabled={installing}>Later</button>
      </div>
    {:else}
      <span>Tauri Explorer {update.version} is available.</span>
      <div class="update-actions dialog-actions">
        <button type="button" class="btn primary" onclick={viewRelease}>View release</button>
        <button type="button" class="btn secondary" onclick={() => (update = null)}>Dismiss</button>
      </div>
    {/if}
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
