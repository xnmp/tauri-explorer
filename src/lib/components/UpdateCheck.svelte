<!--
  Update check host (#185, #1679). Kept out of the startup bundle: after
  startup settles, and at most once a day, it loads `UpdateNotice`, which
  performs the check and shows any offer. A palette "Check for Updates"
  (#1901) loads it immediately, bypassing the throttle.
-->
<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { shouldCheckForUpdate } from "$lib/api/update-throttle";
  import { updateRequest } from "$lib/state/update-request.svelte";

  /** Delay so the check never competes with startup work. */
  const STARTUP_DELAY_MS = 5000;

  let Notice = $state<Component | null>(null);
  let loading = false;

  function loadNotice(): void {
    if (Notice || loading) return;
    loading = true;
    import("./UpdateNotice.svelte")
      .then((module) => (Notice = module.default))
      .catch(() => {
        // A failed chunk load just skips today's check.
        loading = false;
      });
  }

  onMount(() => {
    const timer = setTimeout(() => {
      if (shouldCheckForUpdate()) loadNotice();
    }, STARTUP_DELAY_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (updateRequest.manualRequest > 0) loadNotice();
  });
</script>

{#if Notice}
  <Notice />
{/if}
