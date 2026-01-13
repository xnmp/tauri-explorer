<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { explorer } from "$lib/state/explorer.svelte";
  import NavigationBar from "$lib/components/NavigationBar.svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import FileList from "$lib/components/FileList.svelte";
  import NewFolderDialog from "$lib/components/NewFolderDialog.svelte";
  import RenameDialog from "$lib/components/RenameDialog.svelte";
  import DeleteDialog from "$lib/components/DeleteDialog.svelte";

  onMount(() => {
    const home = "/home";
    explorer.navigateTo(home);
  });
</script>

<main class="explorer">
  <NavigationBar />
  <Toolbar />
  <div class="main-content">
    <Sidebar />
    <FileList />
  </div>
</main>

<NewFolderDialog />
<RenameDialog />
<DeleteDialog />

<style>
  /* Windows 11 Fluent Design System */
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(:root) {
    /* Typography */
    --font-family: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
    --font-size-caption: 12px;
    --font-size-body: 14px;
    --font-size-subtitle: 16px;
    --font-size-title: 20px;

    /* Light theme - Windows 11 palette */
    --accent: #0078d4;
    --accent-light: #60cdff;
    --accent-dark: #005a9e;

    --text-primary: #1a1a1a;
    --text-secondary: #5d5d5d;
    --text-tertiary: #8a8a8a;
    --text-on-accent: #ffffff;

    --background-solid: #f3f3f3;
    --background-mica: rgba(243, 243, 243, 0.85);
    --background-acrylic: rgba(255, 255, 255, 0.7);
    --background-card: rgba(255, 255, 255, 0.7);
    --background-card-secondary: rgba(249, 249, 249, 0.5);

    --surface-stroke: rgba(0, 0, 0, 0.0578);
    --surface-stroke-flyout: rgba(0, 0, 0, 0.0326);
    --divider: rgba(0, 0, 0, 0.0803);

    --control-fill: rgba(255, 255, 255, 0.7);
    --control-fill-secondary: rgba(249, 249, 249, 0.5);
    --control-fill-tertiary: rgba(249, 249, 249, 0.3);
    --control-fill-disabled: rgba(249, 249, 249, 0.3);

    --subtle-fill: transparent;
    --subtle-fill-secondary: rgba(0, 0, 0, 0.0373);
    --subtle-fill-tertiary: rgba(0, 0, 0, 0.0241);

    --control-stroke: rgba(0, 0, 0, 0.0578);
    --control-stroke-secondary: rgba(0, 0, 0, 0.1622);

    --focus-stroke-outer: #000000;
    --focus-stroke-inner: #ffffff;

    --system-critical: #c42b1c;
    --system-success: #0f7b0f;
    --system-caution: #9d5d00;

    /* Shadows - Windows 11 elevation */
    --shadow-flyout: 0 8px 16px rgba(0, 0, 0, 0.14);
    --shadow-dialog: 0 32px 64px rgba(0, 0, 0, 0.24), 0 2px 21px rgba(0, 0, 0, 0.18);
    --shadow-tooltip: 0 4px 8px rgba(0, 0, 0, 0.14);

    /* Radii */
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;

    /* Transitions */
    --transition-fast: 67ms cubic-bezier(0, 0, 0, 1);
    --transition-normal: 167ms cubic-bezier(0, 0, 0, 1);
    --transition-slow: 250ms cubic-bezier(0, 0, 0, 1);

    /* Spacing */
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 12px;
    --spacing-lg: 16px;
    --spacing-xl: 24px;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root) {
      /* Dark theme - Windows 11 palette */
      --accent: #60cdff;
      --accent-light: #98ecff;
      --accent-dark: #0078d4;

      --text-primary: #ffffff;
      --text-secondary: #c5c5c5;
      --text-tertiary: #9d9d9d;
      --text-on-accent: #000000;

      --background-solid: #202020;
      --background-mica: rgba(32, 32, 32, 0.9);
      --background-acrylic: rgba(44, 44, 44, 0.96);
      --background-card: rgba(255, 255, 255, 0.0512);
      --background-card-secondary: rgba(255, 255, 255, 0.0326);

      --surface-stroke: rgba(255, 255, 255, 0.0698);
      --surface-stroke-flyout: rgba(255, 255, 255, 0.093);
      --divider: rgba(255, 255, 255, 0.0837);

      --control-fill: rgba(255, 255, 255, 0.0605);
      --control-fill-secondary: rgba(255, 255, 255, 0.0837);
      --control-fill-tertiary: rgba(255, 255, 255, 0.0326);
      --control-fill-disabled: rgba(255, 255, 255, 0.0419);

      --subtle-fill: transparent;
      --subtle-fill-secondary: rgba(255, 255, 255, 0.0605);
      --subtle-fill-tertiary: rgba(255, 255, 255, 0.0419);

      --control-stroke: rgba(255, 255, 255, 0.093);
      --control-stroke-secondary: rgba(255, 255, 255, 0.0698);

      --focus-stroke-outer: #ffffff;
      --focus-stroke-inner: #000000;

      --system-critical: #ff99a4;
      --system-success: #6ccb5f;
      --system-caution: #fce100;

      --shadow-flyout: 0 8px 16px rgba(0, 0, 0, 0.26);
      --shadow-dialog: 0 32px 64px rgba(0, 0, 0, 0.32), 0 2px 21px rgba(0, 0, 0, 0.24);
    }
  }

  :global(body) {
    font-family: var(--font-family);
    font-size: var(--font-size-body);
    line-height: 1.43;
    color: var(--text-primary);
    background: var(--background-solid);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Selection styling */
  :global(::selection) {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  /* Scrollbar styling - Windows 11 style */
  :global(::-webkit-scrollbar) {
    width: 14px;
    height: 14px;
  }

  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(::-webkit-scrollbar-thumb) {
    background: var(--text-tertiary);
    border: 4px solid transparent;
    border-radius: 7px;
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--text-secondary);
    border: 4px solid transparent;
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-corner) {
    background: transparent;
  }

  .explorer {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--background-mica);
    backdrop-filter: blur(60px) saturate(125%);
    -webkit-backdrop-filter: blur(60px) saturate(125%);
  }

  /* Mica effect gradient overlay */
  .explorer::before {
    content: "";
    position: fixed;
    inset: 0;
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.05) 0%,
      transparent 50%
    );
    pointer-events: none;
    z-index: 0;
  }

  @media (prefers-color-scheme: dark) {
    .explorer::before {
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.02) 0%,
        transparent 50%
      );
    }
  }

  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }
</style>
