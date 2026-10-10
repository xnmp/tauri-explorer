<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import AiOperationConfirmation from "./AiOperationConfirmation.svelte";
  import { readAiOperations, resolveAiOperation, watchAiOperations } from "$lib/api/ai-operations";
  import { createAiOperationsController, type AiOperationsDependencies, type AiOperationsView } from "$lib/state/ai-operations";
  import { aiOperationKey, type UnresolvedAiOperation } from "$lib/domain/ai-operations";
  import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
  import { installedPackages } from "$lib/plugins/installed";
  import { pluginRegistry } from "$lib/plugins/registry.svelte";
  let { onClose, dependencies = { read: readAiOperations, resolve: resolveAiOperation, watch: watchAiOperations } }: { onClose: () => void; dependencies?: AiOperationsDependencies } = $props();
  let view = $state<AiOperationsView>({ snapshot: null, loading: false, busyKey: null, error: null });
  let confirmation = $state<{ operation: UnresolvedAiOperation; action: "discard" | "stop" } | null>(null);
  let configuring = $state(false), connectionError = $state("");
  let alive = true;
  const controller = untrack(() => createAiOperationsController(dependencies, (next) => { view = next; }));
  onMount(() => { void controller.init(); return () => { alive = false; controller.dispose(); }; });
  async function confirm(): Promise<void> {
    const current = confirmation;
    if (current && await controller.resolve(current.operation, current.action) && alive) confirmation = null;
  }
  async function configure(): Promise<void> {
    if (configuring) return;
    configuring = true; connectionError = "";
    try {
      const packageEntry = installedPackages().find((p) => p.manifest.id === "xnmp.image-generation");
      if (!packageEntry) throw new Error("Install the Image Generation package in Plugins to configure connections.");
      if (!packageEntry.enabled) throw new Error("Enable the Image Generation package in Plugins to configure connections.");
      if (!pluginRegistry.plugins.some((p) => p.id === "image-generation" && p.enabled)) throw new Error("Enable the Image Generation settings contribution in Plugins to configure connections.");
      await dialogRegistry.openManaged("image-generation.connections").result;
      if (alive) await controller.refresh();
    } catch (failure) { if (alive) connectionError = failure instanceof Error ? failure.message : "Connections could not be opened"; }
    finally { if (alive) configuring = false; }
  }
  function age(value: number | null): string { return value === null ? "Age unavailable" : new Date(value).toLocaleString(); }
</script>
<Modal open={true} {onClose} labelledby="ai-operations-title" canClose={() => !view.busyKey && !configuring}>
  <div class="modal-card operations">
    <header><h2 id="ai-operations-title">Unresolved AI operations</h2><button onclick={onClose} disabled={!!view.busyKey || configuring} aria-label="Close unresolved operations">×</button></header>
    <p class="intro">Inspect the original operation and recover its retained result. Resume never generates another image. Closing this dialog keeps its receipts and bytes.</p>
    <div class="toolbar"><button disabled={view.loading || !!view.busyKey} onclick={() => controller.refresh()}>Reload operations</button><button disabled={configuring || !!view.busyKey} onclick={configure}>{configuring ? "Connections open…" : "Configure image connections"}</button></div>
    {#if view.error}<p role="alert">{view.error}</p>{/if}
    {#if connectionError}<p role="alert">{connectionError}</p>{/if}
    {#if view.snapshot?.migration?.state === "pending"}<p role="status">Legacy image settings migration is pending. {view.snapshot.migration.error ?? "Resolve its configuration issue before generating with migrated connections."}</p>{/if}
    <div class="content" aria-busy={view.loading}>
      {#if !view.snapshot && view.loading}<p role="status">Loading retained operations…</p>
      {:else if view.snapshot?.operations.length === 0}<p role="status">No unresolved AI operations.</p>
      {:else if view.snapshot}
        <ul>{#each view.snapshot.operations as operation (aiOperationKey(operation))}
          <li data-operation-id={operation.operationId}>
            <strong>{operation.operationId}</strong><div class="packages">{operation.consumerPackage} → {operation.providerPackage}</div><div class="age">{age(operation.createdAtMs)}</div>
            <dl><dt>Execution</dt><dd>{operation.execution}</dd><dt>Delivery</dt><dd>{operation.delivery}</dd></dl><p>{operation.reason}</p>
            <div class="actions">
              {#if operation.canResume}<button disabled={!!view.busyKey} onclick={() => controller.resolve(operation, "resume")}>Resume original recovery</button>{/if}
              {#if operation.canDiscard}<button disabled={!!view.busyKey} onclick={() => { confirmation = { operation: { ...operation }, action: "discard" }; }}>Discard retained result…</button>{/if}
              {#if operation.canStop}<button disabled={!!view.busyKey} onclick={() => { confirmation = { operation: { ...operation }, action: "stop" }; }}>Stop active recovery…</button>{/if}
            </div>
          </li>
        {/each}</ul>
      {/if}
    </div>
  </div>
</Modal>
{#if confirmation}<AiOperationConfirmation operation={confirmation.operation} action={confirmation.action} busy={!!view.busyKey} error={view.error} onConfirm={confirm} onClose={() => { confirmation = null; }} />{/if}
<style>
  .operations { width: 640px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); box-sizing: border-box; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; } h2 { margin: 0; font-size: 18px; }
  .intro, p { margin: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; } .intro, .age, .packages { color: var(--text-secondary); }
  .toolbar, .actions { display: flex; flex-wrap: wrap; gap: 8px; } .content { overflow: auto; min-height: 0; } ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  li { border: 1px solid var(--surface-stroke); border-radius: var(--radius-sm); padding: 12px; display: grid; gap: 8px; overflow-wrap: anywhere; } strong { font-size: 13px; } .packages, .age { font-size: 12px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 12px; } dd { margin: 0; }
  button { font: inherit; font-size: 12px; padding: 6px 10px; background: var(--control-fill); color: var(--text-primary); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; } button:disabled { opacity: .5; cursor: default; } [role="alert"] { color: var(--system-critical-text, var(--system-critical)); }
  @media (max-width: 400px) { .operations { padding: 12px; } .toolbar button { flex: 1; } }
</style>
