<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  let { open, onClose }: { open: boolean; onClose: () => void } = $props();
  let confirming = $state(false);
  let busy = $state(false);
  let draft = $state("Unsaved child");
</script>

<Modal {open} onClose={() => confirming = true} canClose={() => !busy} label="Dirty child">
  <div class="modal-card">
    <h2>Dirty child</h2>
    <label>Child draft <input bind:value={draft} disabled={busy} data-autofocus /></label>
    <button type="button" onclick={() => busy = !busy}>{busy ? "Finish pending work" : "Start pending work"}</button>
    {#if confirming}
      <p role="alert">Discard unsaved child?</p>
      <button type="button" onclick={() => confirming = false}>Keep editing child</button>
      <button type="button" onclick={onClose}>Discard child</button>
    {/if}
  </div>
</Modal>
