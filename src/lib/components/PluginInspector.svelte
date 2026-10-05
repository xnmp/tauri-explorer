<script lang="ts">
  import { inspectorRegistry } from "$lib/plugins/inspector-registry.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";

  const entries = $derived(windowTabsManager.getActiveExplorer()?.getSelectedEntries() ?? []);
  const contributions = $derived(inspectorRegistry.itemsFor(entries));
</script>

{#if contributions.length > 0}
  <aside class="plugin-inspector" aria-label="File inspector">
    {#each contributions as contribution (contribution.id)}
      <section aria-label={contribution.title}>
        <header>{contribution.title}</header>
        <contribution.component {...contribution.props} {entries} />
      </section>
    {/each}
  </aside>
{/if}

<style>
  .plugin-inspector {
    box-sizing: border-box;
    flex: 0 0 clamp(300px, 28vw, 380px);
    min-width: 0;
    max-width: 45vw;
    overflow: auto;
    border-left: 1px solid var(--surface-stroke);
    background: var(--background-card);
  }
  header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--surface-stroke);
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 650;
  }
  section + section { border-top: 1px solid var(--surface-stroke); }
  @container explorer-workspace (max-width: 1000px) {
    .plugin-inspector {
      flex: 0 1 38%;
      min-height: 0;
      max-height: 38%;
      max-width: none;
      border-left: 0;
      border-top: 1px solid var(--surface-stroke);
    }
  }
</style>
