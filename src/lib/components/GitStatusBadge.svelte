<!--
  Git status indicator badge.
  Shows single-letter git status (M/U/A/D/!/R) with color coding.
  Issue: fix/view-component-duplication
-->
<script lang="ts">
  import { getContext } from "svelte";
  import { gitStatusLetter } from "$lib/domain/git";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { PaneId } from "$lib/state/types";

  interface Props {
    entryName: string;
    /** Hide badge during rename to avoid overlap */
    hideOnRename?: boolean;
  }

  let { entryName, hideOnRename = false }: Props = $props();

  // Statuses are keyed per directory; look up via the directory this entry
  // is rendered in (the owning pane's current path) so dual panes showing
  // different directories don't bleed badges into each other.
  const paneId = getContext<PaneId | undefined>("pane-id");
  const directory = $derived(
    paneId ? windowTabsManager.getExplorer(paneId)?.currentPath ?? "" : "",
  );
  const gitStatus = $derived(
    settingsStore.showGitStatus && directory
      ? gitStatusStore.getStatus(directory, entryName)
      : null,
  );
</script>

{#if gitStatus && !hideOnRename}
  <span class="git-indicator git-{gitStatus.toLowerCase()}" title="Git: {gitStatus}">
    {gitStatusLetter(gitStatus)}
  </span>
{/if}

<style>
  .git-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    line-height: 1;
    opacity: 0.85;
  }

  .git-modified { color: #d4a017; }
  .git-untracked { color: #22c55e; }
  .git-added { color: #22c55e; }
  .git-deleted { color: #ef4444; }
  .git-conflict { color: #ef4444; font-weight: 800; }
  .git-renamed { color: #60a5fa; }
  .git-copied { color: #60a5fa; }
  .git-ignored { color: #6b7280; }
  .git-typechange { color: #a78bfa; }
</style>
