<!--
  Git status indicator badge.
  Shows single-letter git status (M/U/A/D/!/R) with color coding.
  Issue: fix/view-component-duplication
-->
<script lang="ts">
  import { gitStatusLetter } from "$lib/domain/git";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";

  interface Props {
    entryName: string;
    /** Hide badge during rename to avoid overlap */
    hideOnRename?: boolean;
  }

  let { entryName, hideOnRename = false }: Props = $props();

  const gitStatus = $derived(settingsStore.showGitStatus ? gitStatusStore.getStatus(entryName) : null);
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
</style>
