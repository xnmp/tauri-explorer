<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { OpenDialog } from "$lib/plugins/dialog-registry.svelte";
  import { setDialogPresentation } from "$lib/state/dialog-presentation-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";

  let { dialog, children }: { dialog: OpenDialog; children: Snippet } = $props();
  const scope = untrack(() => dialog.scope);
  const panes = windowTabsManager.paneDialogs;
  const visible = $derived(!scope || (panes.isVisible(scope) && !!panes.slot(scope) && !dialogStore.hasModalOpen));
  setDialogPresentation({
    scope, presentation: untrack(() => dialog.presentation),
    get visible() { return visible; },
    isActive: () => !scope || panes.isActive(scope),
    focusUncovered: () => { if (scope && !dialogStore.hasModalOpen) panes.focusUncovered(scope); },
  });
  function portal(container: HTMLElement) {
    // Svelte owns this component in WindowDialogs for its entire lifetime.
    // Only this container moves; its parking parent always stays in place.
    const parking = container.parentElement!;
    return { destroy: panes.mount(scope!, container, parking) };
  }
</script>

{#if scope}
  <div class="dialog-parking" hidden inert>
    <div class="pane-dialog-container" data-pane-dialog={scope.paneId} hidden={!visible} inert={!visible} use:portal>
      {@render children()}
    </div>
  </div>
{:else}
  {@render children()}
{/if}

<style>
  .dialog-parking { display: none; }
  .pane-dialog-container {
    position: absolute;
    inset: 0;
    pointer-events: auto;
  }
  .pane-dialog-container[hidden] { display: none; }
</style>
