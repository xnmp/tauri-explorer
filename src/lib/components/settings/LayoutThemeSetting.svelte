<!--
  LayoutThemeSetting — the Appearance "Layout" control (#1306): the layout
  selector, "Open layouts folder", "Reset to Default" and the fallback
  explanation. Lives in the lazily loaded Settings dialog, so it
  may import the layout controller.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { layoutController, refreshLayoutCatalog } from "$lib/state/layout-controller.svelte";
  import { DEFAULT_LAYOUT_ID } from "$lib/domain/layout-theme";
  import { ensureLayoutsDir } from "$lib/api/layouts";
  import { navigateFromSidebar } from "$lib/state/sidebar-navigation";
  import { toastStore } from "$lib/state/toast.svelte";

  interface Props {
    /** Close the Settings dialog before navigating to the layouts folder. */
    onClose: () => void;
  }

  const { onClose }: Props = $props();

  // Re-read the folder each time Settings opens; the watcher keeps it fresh after.
  onMount(() => { void refreshLayoutCatalog(); });

  const selected = $derived(settingsStore.layoutTheme);
  const fallback = $derived(layoutController.fallback?.requested === selected ? layoutController.fallback : null);

  async function openLayoutsFolder(): Promise<void> {
    const result = await ensureLayoutsDir();
    if (!result.ok) {
      toastStore.error(`Could not open the layouts folder: ${result.error}`);
      return;
    }
    onClose();
    navigateFromSidebar(result.data);
  }
</script>

<div class="layout-theme-setting">
  <select class="settings-select layout-theme-select" value={selected}
    onchange={(e) => settingsStore.update({ layoutTheme: e.currentTarget.value })}>
    {#each layoutController.themes as layout (layout.id)}
      <option value={layout.id}>{layout.name}</option>
    {/each}
    {#if !layoutController.themes.some((layout) => layout.id === selected)}
      <option value={selected}>{selected} (unavailable)</option>
    {/if}
  </select>
  <div class="layout-actions">
    <button class="layout-action open-layouts-folder" onclick={openLayoutsFolder}>Open layouts folder</button>
    <button class="layout-action reset-layout" disabled={selected === DEFAULT_LAYOUT_ID}
      onclick={() => settingsStore.update({ layoutTheme: DEFAULT_LAYOUT_ID })}>Reset to Default</button>
  </div>
  {#if fallback}
    <p class="layout-fallback" role="status">
      Using Default: {layoutController.describeFallback(fallback.reason)}.
    </p>
  {/if}
</div>

<style>
  .layout-theme-setting {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    min-width: 0;
  }

  .layout-actions {
    display: flex;
    gap: 6px;
  }

  .layout-action {
    padding: 4px 10px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-caption);
    cursor: pointer;
  }

  .layout-action:hover:not(:disabled) {
    background: var(--control-fill-secondary);
  }

  .layout-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .layout-action:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
  }

  .layout-fallback {
    max-width: 260px;
    margin: 0;
    font-size: var(--font-size-caption);
    color: var(--system-critical-text, var(--system-critical));
    text-align: right;
  }
</style>
