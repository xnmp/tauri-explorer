<!--
  RecentCountMenu - Recent section-header context menu choosing how many recent
  locations the sidebar lists (#1661). Writes the shared recentItemsCount setting.
-->
<script lang="ts">
  import { settingsStore } from "$lib/state/settings.svelte";
  import { recentItemsCountChoices } from "$lib/domain/settings-numbers";
  import SidebarSectionMenu from "./SidebarSectionMenu.svelte";

  let { position, onclose }: { position: { x: number; y: number }; onclose: () => void } = $props();

  function choose(count: number) {
    settingsStore.setRecentItemsCount(count);
    onclose();
  }
</script>

<SidebarSectionMenu {position} {onclose} label="Recent items to show">
  <div class="menu-label">Show recent items</div>
  {#each recentItemsCountChoices(settingsStore.recentItemsCount) as count (count)}
    {@const checked = count === settingsStore.recentItemsCount}
    <button class="section-menu-item" role="menuitemradio" aria-checked={checked} onclick={() => choose(count)}>
      <span class="check" aria-hidden="true">
        {#if checked}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.25L5 8.75L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </span>
      {count}
    </button>
  {/each}
</SidebarSectionMenu>

<style>
  .menu-label {
    padding: 4px 10px 2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
  }
  .check {
    display: inline-flex;
    width: 12px;
    height: 12px;
    color: var(--accent-text, var(--accent));
  }
</style>
