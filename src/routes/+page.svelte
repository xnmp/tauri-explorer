<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { explorer } from "$lib/state/explorer.svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { getHomeDirectory } from "$lib/api/files";
  import "$lib/themes/index.css";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import NavigationBar from "$lib/components/NavigationBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import FileList from "$lib/components/FileList.svelte";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import NewFolderDialog from "$lib/components/NewFolderDialog.svelte";
  import DeleteDialog from "$lib/components/DeleteDialog.svelte";

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    const isModifier = event.ctrlKey || event.metaKey;
    const selected = explorer.getSelectedEntries()[0];

    // Alt + Arrow: Navigation
    if (event.altKey) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        explorer.goBack();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        explorer.goForward();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        explorer.goUp();
      }
      return;
    }

    // F5: Refresh
    if (event.key === "F5") {
      event.preventDefault();
      explorer.refresh();
      return;
    }

    // Modifier shortcuts (Ctrl/Cmd + key)
    if (!isModifier) return;

    if (event.key === "z") {
      event.preventDefault();
      explorer.undo();
    } else if (event.key === "c" && selected) {
      event.preventDefault();
      explorer.copyToClipboard(selected);
    } else if (event.key === "x" && selected) {
      event.preventDefault();
      explorer.cutToClipboard(selected);
    } else if (event.key === "v" && explorer.state.clipboard) {
      event.preventDefault();
      await explorer.paste();
    }
  }

  onMount(() => {
    // Initialize theme from saved preference
    themeStore.initTheme();

    // Global keyboard shortcuts
    window.addEventListener("keydown", handleKeydown);

    // Get the actual home directory from the backend
    (async () => {
      const result = await getHomeDirectory();
      if (result.ok) {
        explorer.navigateTo(result.data);
      } else {
        explorer.navigateTo("/home");
      }
    })();

    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<main class="explorer">
  <TitleBar />
  <NavigationBar />
  <div class="main-content">
    <Sidebar />
    <FileList />
  </div>
</main>

<ContextMenu />
<NewFolderDialog />
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


  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }
</style>
