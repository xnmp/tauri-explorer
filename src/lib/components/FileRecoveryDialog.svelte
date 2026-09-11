<script lang="ts">
  import { formatRecoveryBytes, summarizeRecoveryStorage } from "$lib/domain/file-recovery";
  import type { FileRecoveryItem, FileRecoveryChoice } from "$lib/domain/file-recovery";
  import type { FileRecoverySession } from "$lib/state/file-recovery-session.svelte";
  import "./modal.css";
  import { tick } from "svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    open: boolean;
    recovery: FileRecoverySession;
    onClose: () => void;
  }

  let { open, onClose, recovery }: Props = $props();
  const store = $derived(recovery.state);
  const items = $derived(store?.items ?? []);
  const storage = $derived(store?.storage ?? null);
  const usage = $derived(storage ? summarizeRecoveryStorage(storage) : null);
  let card = $state<HTMLDivElement | null>(null);
  let pendingDiscard = $state<FileRecoveryItem | null>(null);
  let discardCancelButton = $state<HTMLButtonElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);

  function discardTrigger(id: string): HTMLButtonElement | null {
    return [...document.querySelectorAll<HTMLButtonElement>("[data-recovery-discard]")]
      .find((button) => button.dataset.recoveryDiscard === id) ?? null;
  }

  async function openDiscardConfirmation(item: FileRecoveryItem): Promise<void> {
    pendingDiscard = item;
    await tick();
    if (pendingDiscard?.id === item.id) discardCancelButton?.focus();
  }

  async function closeDiscardConfirmation(id: string, restoreFocus = true): Promise<void> {
    pendingDiscard = null;
    if (!restoreFocus) return;
    await tick();
    (discardTrigger(id) ?? closeButton)?.focus();
  }

  $effect(() => {
    if (!open && pendingDiscard) {
      pendingDiscard = null;
      return;
    }
    if (pendingDiscard && !items.some(
      (item) => item.id === pendingDiscard?.id
        && item.generation === pendingDiscard.generation
        && item.actions.includes("discard"),
    )) void closeDiscardConfirmation(pendingDiscard.id);
  });

  async function runItemAction(id: string, action: () => Promise<void>): Promise<void> {
    const currentCard = card;
    const stableFocus = closeButton;
    const focused = document.activeElement;
    const ownsFocus = !!focused && !!currentCard?.contains(focused);
    // Accepted work disables/removes its trigger. Keep focus inside the modal
    // throughout the request, including while native work is still pending.
    if (ownsFocus) stableFocus?.focus();
    await action();
    await tick();
    if (!open || card !== currentCard || !currentCard?.isConnected
      || !ownsFocus || document.activeElement !== stableFocus) return;
    const inspect = [...currentCard.querySelectorAll<HTMLButtonElement>("[data-recovery-inspect]")]
      .find((button) => button.dataset.recoveryInspect === id && !button.disabled);
    (inspect ?? stableFocus)?.focus();
  }

  function resolve(item: FileRecoveryItem, choice: FileRecoveryChoice): void {
    const state = store;
    if (!state || state.busyId) return;
    void runItemAction(item.id, async () => {
      pendingDiscard = null;
      await state.resolve(item, choice);
    });
  }
</script>

<Modal {open} {onClose} overlayClass="file-recovery-overlay" labelledby="file-recovery-title">
  <div bind:this={card} class="recovery-dialog modal-card" aria-busy={recovery.loading || !!store?.busyId}>
    <div class="dialog-header">
      <div>
        <h2 id="file-recovery-title">File recovery</h2>
        <p class="dialog-subtitle">Review file operations that need your attention.</p>
      </div>
      <button bind:this={closeButton} type="button" class="close-button" aria-label="Close file recovery" onclick={onClose} data-autofocus>×</button>
    </div>

    {#if recovery.error}
      <div class="error-panel" role="alert">
        <span>{recovery.error}</span>
        <button type="button" class="retry-button" onclick={() => void recovery.refresh()} disabled={recovery.loading || !!store?.busyId}>Retry</button>
      </div>
    {/if}

    {#if usage && storage}
      <section class="storage" aria-label="Retained file storage" data-recovery-storage>
        <div class="storage-heading">
          <strong>Retained files</strong>
          <span data-recovery-usage>{usage.usedLabel} of {usage.budgetLabel} · {storage.records} of {storage.recordBudget} records</span>
        </div>
        <div class="storage-meter" role="img" aria-label="{Math.round(usage.percent)}% of the retained file budget is in use">
          <div class="storage-fill" class:full={usage.atCapacity} style:width="{usage.percent}%"></div>
        </div>
        {#each usage.notes as note (note)}
          <p class="storage-note" class:critical={usage.atCapacity}>{note}</p>
        {/each}
      </section>
    {/if}

    <div class="recovery-toolbar">
      <button type="button" class="btn secondary" onclick={() => void store?.retireEligible()} disabled={recovery.loading || !!store?.busyId || !store} data-recovery-reclaim>Reclaim space</button>
      <button type="button" class="btn secondary" onclick={() => void recovery.refresh()} disabled={recovery.loading || !!store?.busyId}>Refresh</button>
    </div>

    {#if (recovery.loading || (!store && !recovery.error)) && items.length === 0}
      <p class="state-message" role="status">Loading recovery items…</p>
    {:else if items.length === 0 && !recovery.error}
      <p class="state-message">No file recovery actions are pending.</p>
    {:else}
      <ul class="recovery-list">
        {#each items as item (item.id)}
          {@const details = store?.inspection?.id === item.id
            && store?.inspection.generation === item.generation
            ? store?.inspection : null}
          <li class="recovery-item">
            <div class="item-heading">
              <strong title={item.originalPath}>{item.originalPath}</strong>
              <span class="status" class:critical={item.status === "attention"}>{item.status}</span>
            </div>
            <p>{item.message}</p>
            {#if item.retainedPath}
              <p class="retained-size" data-recovery-retained={item.id}>Retained: {formatRecoveryBytes(item.retainedBytes)}</p>
            {/if}

            {#if details}
              <dl class="inspection">
                <div><dt>Original</dt><dd>{details.originalPath}</dd></div>
                {#if details.retainedPath}<div><dt>Artifacts</dt><dd>{details.retainedPath}</dd></div>{/if}
              </dl>
            {:else if store?.inspectionError
              && store?.inspectionId === item.id
              && store?.inspectionGeneration === item.generation}
              <p class="inspection-error" role="alert">{store?.inspectionError}</p>
            {/if}

            {#if pendingDiscard?.id === item.id && pendingDiscard.generation === item.generation}
              <div class="discard-confirmation" role="alert">
                <strong>Delete the retained original?</strong>
                <p>This permanently removes the retained data and cannot be undone.</p>
                <div class="confirmation-actions">
                  <button bind:this={discardCancelButton} type="button" class="btn secondary" onclick={() => void closeDiscardConfirmation(item.id)}>Cancel</button>
                  <button type="button" class="btn danger" onclick={() => resolve(item, "discard")} disabled={!!store?.busyId || recovery.loading}>Delete retained original</button>
                </div>
              </div>
            {:else}
              <div class="item-actions">
                <button type="button" class="btn secondary" data-recovery-inspect={item.id} onclick={() => void runItemAction(item.id, async () => { await store?.inspect(item.id); })} disabled={!!store?.busyId || recovery.loading || store?.inspectingId === item.id}>
                  {store?.inspectingId === item.id ? "Inspecting…" : "Inspect"}
                </button>
                {#if item.actions.includes("restore")}
                  <button type="button" class="btn primary" onclick={() => resolve(item, "restore")} disabled={!!store?.busyId || recovery.loading}>Restore</button>
                {/if}
                {#if item.actions.includes("discard")}
                  <button type="button" class="btn danger" data-recovery-discard={item.id} onclick={() => void openDiscardConfirmation(item)} disabled={!!store?.busyId || recovery.loading}>Discard…</button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Modal>

<style>
  .recovery-toolbar { display: flex; justify-content: flex-end; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); }
  .storage { margin: var(--spacing-md) 0 var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--divider); border-radius: var(--radius-sm); background: var(--background-card-secondary); }
  .storage-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--spacing-md); font-size: var(--font-size-caption); }
  .storage-heading strong { color: var(--text-primary); font-size: var(--font-size-body); }
  .storage-heading span { color: var(--text-secondary); }
  .storage-meter { height: 6px; margin-top: var(--spacing-xs); border-radius: 3px; background: var(--subtle-fill-secondary); overflow: hidden; }
  .storage-fill { height: 100%; background: var(--accent-default, var(--text-secondary)); }
  .storage-fill.full { background: var(--system-critical); }
  .storage-note { margin: var(--spacing-xs) 0 0; color: var(--text-secondary); font-size: var(--font-size-caption); }
  .storage-note.critical { color: var(--system-critical); }
  .retained-size { margin: 0 0 var(--spacing-sm) !important; color: var(--text-secondary); font-size: var(--font-size-caption); }
  .status.critical { color: var(--system-critical); }
  .recovery-dialog { width: min(620px, calc(100vw - 32px)); max-width: 620px; }
  .dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-lg); }
  .close-button, .retry-button { border: 0; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; }
  .close-button { width: 28px; height: 28px; border-radius: var(--radius-sm); font-size: 20px; line-height: 1; }
  .close-button:hover, .retry-button:hover { background: var(--subtle-fill-secondary); color: var(--text-primary); }
  .close-button:focus-visible, .retry-button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .error-panel { display: flex; justify-content: space-between; gap: var(--spacing-md); margin-bottom: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--system-critical); border-radius: var(--radius-sm); color: var(--system-critical); font-size: var(--font-size-caption); }
  .retry-button { min-height: 24px; color: inherit; font-weight: 600; }
  .state-message { margin: var(--spacing-xl) 0; color: var(--text-secondary); text-align: center; }
  .recovery-list { display: flex; flex-direction: column; gap: var(--spacing-sm); max-height: min(55vh, 520px); margin: 0; padding: 0; overflow-y: auto; list-style: none; }
  .recovery-item { padding: var(--spacing-md); border: 1px solid var(--divider); border-radius: var(--radius-sm); background: var(--background-card-secondary); }
  .item-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--spacing-md); }
  .item-heading strong { min-width: 0; overflow: hidden; color: var(--text-primary); font-size: var(--font-size-body); text-overflow: ellipsis; white-space: nowrap; }
  .status { flex-shrink: 0; color: var(--text-secondary); font-size: var(--font-size-caption); text-transform: capitalize; }
  .recovery-item > p { margin: var(--spacing-xs) 0 var(--spacing-sm); color: var(--text-secondary); font-size: var(--font-size-caption); line-height: 1.4; }
  .item-actions, .confirmation-actions { display: flex; justify-content: flex-end; gap: var(--spacing-sm); }
  .inspection { display: grid; gap: var(--spacing-xs); margin: var(--spacing-sm) 0; font-size: var(--font-size-caption); }
  .inspection div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: var(--spacing-sm); }
  .inspection dt { color: var(--text-secondary); }
  .inspection dd { margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); }
  .inspection-error { color: var(--system-critical) !important; }
  .discard-confirmation { margin-top: var(--spacing-sm); padding: var(--spacing-sm); border: 1px solid var(--system-critical); border-radius: var(--radius-sm); }
  .discard-confirmation strong { color: var(--system-critical); }
  .discard-confirmation p { margin: var(--spacing-xs) 0 var(--spacing-sm); color: var(--text-secondary); font-size: var(--font-size-caption); }
  @media (max-width: 480px) { .recovery-dialog { min-width: 0; padding: var(--spacing-lg); } .item-actions, .confirmation-actions { flex-wrap: wrap; } }
</style>
