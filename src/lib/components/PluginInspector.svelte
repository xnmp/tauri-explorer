<script lang="ts">
  import { untrack } from "svelte";
  import { inspectorRegistry } from "$lib/plugins/inspector-registry.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { useResizeOwner } from "$lib/composables/use-resize-owner.svelte";
  import { createScalarResize } from "$lib/state/scalar-resize";
  import { clampResizeSize } from "$lib/domain/resize-size";
  import { loadPersisted, savePersisted } from "$lib/state/persisted";

  const paneId = $props.id();
  let pane = $state<HTMLElement>();
  let workspaceWidth = $state(1200);
  let workspaceHeight = $state(800);
  let preferredWidth = $state<unknown>(loadPersisted("explorer-inspector-width", null));
  let preferredHeight = $state<unknown>(loadPersisted("explorer-inspector-height", null));
  const stacked = $derived(workspaceWidth <= 1000);
  const resizeOptions = $derived(stacked
    ? { min: 96, max: Math.max(96, workspaceHeight * .65), default: Math.min(240, Math.max(96, workspaceHeight * .38)), axis: "y" as const, invert: true }
    : { min: 240, max: Math.max(240, Math.min(720, workspaceWidth - 240)), default: Math.min(380, Math.max(300, workspaceWidth * .28)), axis: "x" as const, invert: true });
  const resize = useResizeOwner(effects => createScalarResize({
    ...effects,
    options: () => resizeOptions,
    read: () => clampResizeSize(stacked ? preferredHeight : preferredWidth, resizeOptions),
    commit(value) {
      if (stacked) { preferredHeight = value; savePersisted("explorer-inspector-height", value); }
      else { preferredWidth = value; savePersisted("explorer-inspector-width", value); }
    },
  }));
  $effect(() => { resizeOptions; untrack(resize.reconcile); });
  $effect(() => {
    const workspace = pane?.closest(".workspace-container");
    if (!workspace) return;
    const measure = () => {
      const style = getComputedStyle(workspace);
      workspaceWidth = parseFloat(style.width);
      workspaceHeight = parseFloat(style.height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  });

  const entries = $derived(windowTabsManager.getActiveExplorer()?.getSelectedEntries() ?? []);
  const contributions = $derived(inspectorRegistry.itemsFor(entries));
  $effect(() => { if (!contributions.length) untrack(resize.retire); });
</script>

{#if contributions.length > 0}
  <aside bind:this={pane} id={paneId} class="plugin-inspector" class:stacked class:resizing={resize.isResizing} aria-label="File inspector" style:flex-basis={`${resize.value}px`}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator -->
    <div class="resize-handle" role="separator" tabindex="0" aria-label="Resize trace pane" aria-orientation={stacked ? "horizontal" : "vertical"}
      aria-controls={paneId} aria-valuemin={resize.min} aria-valuemax={resize.max} aria-valuenow={resize.value}
      onpointerdown={resize.startResize} onpointermove={resize.move} onpointerup={resize.finish}
      onpointercancel={resize.cancelPointer} onlostpointercapture={resize.cancelPointer} onkeydown={resize.keydown}></div>
    <div class="inspector-content">
    {#each contributions as contribution (contribution.id)}
      <section aria-label={contribution.title}>
        <header>{contribution.title}</header>
        <contribution.component {...contribution.props} {entries} />
      </section>
    {/each}
    </div>
  </aside>
{/if}

<style>
  .plugin-inspector {
    position: relative;
    box-sizing: border-box;
    flex: 0 0 auto;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid var(--surface-stroke);
    background: var(--background-card);
  }
  .inspector-content { height: 100%; overflow: auto; }
  .resize-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; z-index: 1; cursor: ew-resize; touch-action: none; }
  .resize-handle:hover, .resizing .resize-handle { background: var(--accent); }
  .resize-handle:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .stacked .resize-handle { right: 0; bottom: auto; width: auto; height: 5px; cursor: ns-resize; }
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
      flex-shrink: 0;
      min-height: 0;
      max-width: none;
      border-left: 0;
      border-top: 1px solid var(--surface-stroke);
    }
  }
</style>
