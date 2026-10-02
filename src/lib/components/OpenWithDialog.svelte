<script lang="ts">
  import Modal from "./Modal.svelte";
  import { openWithStore } from "$lib/state/open-with.svelte";
  import { basename } from "$lib/domain/path";
</script>

<Modal open={openWithStore.isOpen} onClose={openWithStore.close} label="Open with"
  canClose={() => openWithStore.phase !== "launching"}
  closeOnBackdrop={openWithStore.phase !== "launching"} closeOnEscape={openWithStore.phase !== "launching"}>
  <div class="modal-card open-with-dialog" aria-busy={openWithStore.phase === "loading" || openWithStore.phase === "launching"}>
    <div class="dialog-header">
      <h2>Open with</h2>
      <p class="filename" title={openWithStore.path}>{basename(openWithStore.path)}</p>
      <p class="dialog-subtitle">Choose an application for this file. Your default stays the same.</p>
    </div>
    {#if openWithStore.error}
      <p class="error" role="alert">{openWithStore.error}</p>
    {/if}
    {#if openWithStore.phase === "loading"}
      <p role="status">Finding installed applications…</p>
    {:else if openWithStore.applications.length === 0 && !openWithStore.error}
      <p role="status">No installed application is registered for this file type.</p>
    {:else}
      <div class="applications" aria-label="Installed applications">
        {#each openWithStore.applications as application (application.id)}
          <button class="application" disabled={openWithStore.phase === "launching"} onclick={() => openWithStore.choose(application.id)}>
            {application.name}
          </button>
        {/each}
      </div>
    {/if}
    {#if openWithStore.phase === "launching"}<p role="status">Opening file…</p>{/if}
    <div class="dialog-actions">
      <button class="btn" data-autofocus disabled={openWithStore.phase === "launching"} onclick={openWithStore.close}>Cancel</button>
    </div>
  </div>
</Modal>

<style>
  .open-with-dialog { background: var(--background-solid); min-width: 0; width: min(440px, calc(100vw / var(--app-zoom, 1) - 32px)); max-height: calc(100vh / var(--app-zoom, 1) - 32px); display: flex; flex-direction: column; }
  .filename { margin: 8px 0; color: var(--text-primary); overflow-wrap: anywhere; }
  .applications { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; min-height: 0; }
  .application { text-align: left; background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); color: var(--text-primary); padding: 10px 12px; font: inherit; cursor: pointer; }
  .application:hover { background: var(--subtle-fill-secondary); }
  .application:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .application:disabled { opacity: 0.6; cursor: default; }
  .error { color: var(--text-primary); background: var(--control-fill); padding: 10px; overflow-wrap: anywhere; }
  .dialog-header { flex-shrink: 0; }
</style>
