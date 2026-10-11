<script lang="ts">
  import Modal from "./Modal.svelte";
  import { resolutionCopy, type UnresolvedAiOperation } from "$lib/domain/ai-operations";
  let { operation, action, busy, error, onConfirm, onClose }: { operation: UnresolvedAiOperation; action: "discard" | "stop"; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void } = $props();
  const copy = $derived(resolutionCopy(operation, action));
</script>
<Modal open={true} {onClose} role="alertdialog" labelledby="ai-resolution-title" describedby="ai-resolution-body" canClose={() => !busy}>
  <div class="modal-card confirmation">
    <h2 id="ai-resolution-title">{copy.title}</h2>
    <p id="ai-resolution-body">{copy.body}</p>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="actions">
      <button disabled={busy} onclick={onClose} data-autofocus>Keep operation</button>
      <button disabled={busy} aria-busy={busy} onclick={onConfirm}>{busy ? "Recording disposition…" : copy.button}</button>
    </div>
  </div>
</Modal>
<style>
  .confirmation { width: 440px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 20px; }
  h2 { margin: 0; font-size: 16px; } p { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 10px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; } button:disabled { opacity: .5; cursor: default; }
  [role="alert"] { color: var(--system-critical-text, var(--system-critical)); }
</style>
