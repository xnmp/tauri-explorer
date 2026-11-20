<!--
  Git status chip (#1852): the status letter (M/U/A/D/!/R/C/T) on a faint
  tint of its theme colour (`--git-*`, themes/git-status.css). Ignored entries
  show no chip; their name is dimmed by EntryNameLabel instead.
-->
<script lang="ts">
  import { useEntryGitStatus } from "$lib/composables/use-entry-git-status.svelte";

  interface Props {
    entryName: string;
    directory?: string;
    /** Hide badge during rename to avoid overlap */
    hideOnRename?: boolean;
  }

  let { entryName, hideOnRename = false, directory }: Props = $props();

  const git = useEntryGitStatus(() => entryName, () => directory);
</script>

{#if git.presentation?.letter && !hideOnRename}
  <span class="git-indicator git-{git.presentation.tone}" class:emphasis={git.presentation.emphasis}
    style:--git-color={git.presentation.color} title="Git: {git.presentation.status}">
    {git.presentation.letter}
  </span>
{/if}

<style>
  .git-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--git-color) 14%, transparent);
    color: var(--git-color);
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    flex-shrink: 0;
  }

  /* Conflicts need attention: an outline and a heavier letter. The fill stays
     as faint as the other chips', so the letter keeps its contrast. */
  .git-indicator.emphasis {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--git-color) 60%, transparent);
    font-weight: 800;
  }
</style>
