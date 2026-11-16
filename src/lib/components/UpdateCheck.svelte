<!--
  Update check host (#185, #1679). Kept out of the startup bundle: after
  startup settles, and at most once a day, it loads `UpdateNotice`, which
  performs the check and shows any offer.
-->
<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { shouldCheckForUpdate } from "$lib/api/update-throttle";

  /** Delay so the check never competes with startup work. */
  const STARTUP_DELAY_MS = 5000;

  let Notice = $state<Component | null>(null);

  onMount(() => {
    const timer = setTimeout(() => {
      if (!shouldCheckForUpdate()) return;
      import("./UpdateNotice.svelte")
        .then((module) => (Notice = module.default))
        .catch(() => {
          // A failed chunk load just skips today's check.
        });
    }, STARTUP_DELAY_MS);
    return () => clearTimeout(timer);
  });
</script>

{#if Notice}
  <Notice />
{/if}
