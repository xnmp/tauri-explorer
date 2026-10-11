<script lang="ts">
  import { untrack } from "svelte";
  import Modal from "$lib/components/Modal.svelte";
  let { open, onClose, initialDraft = "initial draft" }: {
    open: boolean; onClose(): void; initialDraft?: string;
  } = $props();
  let draft = $state(untrack(() => initialDraft));
  let busy = $state(false);
  let submitted = $state("");
  const instance = crypto.randomUUID();
  let openings = $state(0);
  $effect(() => { if (open) untrack(() => { openings += 1; }); });
  function key(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault(); submitted = draft;
    }
  }
</script>

<Modal {open} {onClose} label="Pane test dialog" canClose={() => !busy} onkeydown={key}>
  <div class="modal-card pane-test-dialog">
    <h2>Pane test dialog</h2>
    <label>Dialog draft <textarea data-autofocus bind:value={draft}></textarea></label>
    <label><input type="checkbox" bind:checked={busy} /> Busy dialog</label>
    <output aria-label="Submitted draft">{submitted}</output>
    <output aria-label="Dialog instance">{instance}</output>
    <output aria-label="Dialog openings">{openings}</output>
    <button class="btn" disabled={busy} onclick={onClose}>Close test dialog</button>
  </div>
</Modal>

<style>
  .pane-test-dialog { width: min(360px, 90%); max-height: 90%; padding: 16px; overflow: auto; }
  h2 { margin: 0 0 12px; font-size: 16px; }
  label { display: block; margin-bottom: 12px; }
  textarea { display: block; width: 100%; min-height: 80px; box-sizing: border-box; }
  output { display: block; font-size: 11px; overflow-wrap: anywhere; }
</style>
