<!--
  ActivityBar - VSCode-style narrow icon strip at the left edge of the sidebar (#52).
  Each entry corresponds to a registered sidebar view.
-->
<script lang="ts">
  import { sidebarViewsStore } from "$lib/state/sidebar-views.svelte";

  const views = $derived(sidebarViewsStore.views);
  const activeId = $derived(sidebarViewsStore.activeId);
</script>

<div class="activity-bar" role="tablist" aria-label="Sidebar views">
  {#each views as view (view.id)}
    {@const Icon = view.icon}
    <button
      type="button"
      class="activity-button"
      class:active={view.id === activeId}
      role="tab"
      aria-selected={view.id === activeId}
      aria-label={view.label}
      title={view.label}
      onclick={() => sidebarViewsStore.setActive(view.id)}
      data-view-id={view.id}
    >
      <Icon />
    </button>
  {/each}
</div>

<style>
  .activity-bar {
    display: flex;
    flex-direction: column;
    width: 48px;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--background-card) calc(var(--sidebar-opacity, 1) * 100%), transparent);
    border-right: 1px solid var(--divider);
    padding: 6px 0;
    gap: 2px;
  }

  .activity-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 44px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    cursor: pointer;
    color: var(--text-tertiary);
    transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
    padding: 0;
  }

  .activity-button:hover {
    color: var(--text-primary);
    background: var(--subtle-fill-secondary);
  }

  .activity-button.active {
    color: var(--text-primary);
    border-left-color: var(--accent);
  }

  .activity-button:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }
</style>
