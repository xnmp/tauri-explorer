<script lang="ts">
  import type { Component } from "svelte";
  import { pluginDomOwnership } from "$lib/state/plugin-dom-ownership";
  let { component: Content, contribution, props }: { component: Component<any>; contribution: Component<any>; props: Record<string, unknown> } = $props();
  let owned = $state(false);
  function mount(root: HTMLElement) {
    const lifetime = pluginDomOwnership.mount(root, contribution);
    owned = true;
    return lifetime;
  }
</script>

<div style="display: contents" use:mount>
  {#if owned}<Content {...props} />{/if}
</div>
