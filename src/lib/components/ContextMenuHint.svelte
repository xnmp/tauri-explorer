<!--
  Shortcut hint of a context-menu item. Command-owned: follows persisted
  overrides and renders nothing when the command is unbound.
-->
<script lang="ts">
  import { getCommandShortcut } from "$lib/state/commands.svelte";

  let { commandId }: { commandId: string } = $props();
  const hint = $derived(getCommandShortcut(commandId));
</script>

{#if hint}<span class="shortcut">{hint}</span>{/if}

<style>
  .shortcut {
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>
