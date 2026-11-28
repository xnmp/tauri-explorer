<!--
  A window tab's leading icon: git branch (folder inside a repo), a miniature
  of the pane layout (split tab, #1935), or the folder icon (special folders
  take their pack icon, #1499). Styled by window-tab-bar.css.
-->
<script lang="ts">
  import NamedFolderIcon from "./NamedFolderIcon.svelte";
  import type { TabDisplay } from "$lib/state/tab-display.svelte";

  let { display }: { display: TabDisplay } = $props();
</script>

{#if display.isGitRoot}
  <!-- Git branch icon: this tab's folder lives inside a git repo. -->
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    class="tab-icon tab-icon-git"
    aria-label="Git repository"
  >
    <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
    <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
    <circle cx="11.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
    <path
      d="M4 5.1V10.9M11.5 5.1V6.5C11.5 8.2 10 9 8 9H6"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>
{:else if display.split}
  <!-- Split tab (#1935): a miniature of the pane layout. The focused
       pane's cell fills on the active tab only (CSS). Frame spans
       x 2–14, y 2.5–13.5 of the 16px box. -->
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="tab-icon tab-icon-split" aria-hidden="true">
    {#each display.split.panes as pane (pane.id)}
      {@const x = 2 + pane.rect.x * 12}
      {@const y = 2.5 + pane.rect.y * 11}
      {#if pane.focused}
        <rect class="split-focus" x={x + 1.4} y={y + 1.4} width={Math.max(pane.rect.w * 12 - 2.8, 0.5)} height={Math.max(pane.rect.h * 11 - 2.8, 0.5)} rx="0.6" />
      {/if}
      {#if pane.rect.x > 0}<line x1={x} y1={y} x2={x} y2={y + pane.rect.h * 11} />{/if}
      {#if pane.rect.y > 0}<line x1={x} y1={y} x2={x + pane.rect.w * 12} y2={y} />{/if}
    {/each}
    <rect class="split-frame" x="2" y="2.5" width="12" height="11" rx="2" />
  </svg>
{:else}
  <!-- A special folder name takes its pack-native icon (#1499). -->
  <NamedFolderIcon name={display.folder ?? ""} class="tab-icon tab-icon-special">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="tab-icon">
      <path d="M2 3.5C2 2.67 2.67 2 3.5 2H6.17L8 3.83H12.5C13.33 3.83 14 4.5 14 5.33V12.5C14 13.33 13.33 14 12.5 14H3.5C2.67 14 2 13.33 2 12.5V3.5Z" />
    </svg>
  </NamedFolderIcon>
{/if}
