<!--
  Main Explorer page.
  Issue: tauri-explorer-iw0
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { explorer } from "$lib/state/explorer.svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import Breadcrumbs from "$lib/components/Breadcrumbs.svelte";
  import FileList from "$lib/components/FileList.svelte";

  onMount(() => {
    // Navigate to home directory on load
    const home = "/home";
    explorer.navigateTo(home);
  });
</script>

<main class="explorer">
  <Toolbar />
  <Breadcrumbs />
  <FileList />
</main>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    color: var(--text-primary, #1a1a1a);
    background: var(--background, #fff);
  }

  :global(:root) {
    --text-primary: #1a1a1a;
    --text-secondary: #666;
    --background: #fff;
    --surface: #f5f5f5;
    --border: #e0e0e0;
    --hover-bg: rgba(0, 0, 0, 0.04);
    --active-bg: rgba(0, 120, 212, 0.1);
    --focus-ring: #0078d4;
    --error: #d32f2f;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --text-primary: #f0f0f0;
      --text-secondary: #999;
      --background: #1e1e1e;
      --surface: #252525;
      --border: #3a3a3a;
      --hover-bg: rgba(255, 255, 255, 0.06);
      --active-bg: rgba(0, 120, 212, 0.2);
    }

    :global(body) {
      background: var(--background);
      color: var(--text-primary);
    }
  }

  .explorer {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
</style>
