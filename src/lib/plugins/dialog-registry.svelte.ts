/**
 * Contribution registry for plugin-provided modal dialogs.
 *
 * A plugin registers a dialog component under a stable id via
 * `ctx.registerDialog({ id, component })`, then opens it with
 * `ctx.openDialog(id, props)` and closes it with `ctx.closeDialog(id)`.
 *
 * `+page.svelte` renders every currently-open dialog by iterating
 * `openDialogs`, injecting `open` + an `onClose` that closes by id. The seam is
 * intentionally generic — any plugin can contribute a modal (an image editor, a
 * rename assistant, etc.); it is not shaped around any one feature.
 */

import { modalOwnership } from "$lib/state/modal-ownership.svelte";
import { createOwnedRegistry } from "$lib/state/owned-registry";
import type { Component } from "svelte";

export interface DialogDescriptor {
  id: string;
  component: Component<any>;
  /** Owner-supplied dependencies, retained for cross-contribution navigation. */
  props?: Record<string, unknown>;
}

export interface OpenDialog {
  id: string;
  instanceId:number;
  component: Component<any>;
  props: Record<string, unknown>;
}
export interface DialogResult {reason:"closed"|"caller-closed"|"owner-disposed"}

function createDialogRegistry() {
  // Registered dialogs are looked up on open; a plain Map (no reactivity) is
  // enough since only the *open* set drives rendering.
  const registered = createOwnedRegistry<DialogDescriptor>();
  let openDialogs = $state<OpenDialog[]>([]);
  const releaseModal = new Map<string, () => void>();
  const sessions=new Map<string,{token:symbol;resolve:(value:DialogResult)=>void;detachCaller:()=>void}>();
  let sequence=0;

  function close(id: string, reason:DialogResult["reason"]="closed"): void {
    releaseModal.get(id)?.();
    releaseModal.delete(id);
    // Remove by id, not object reference: Svelte's `$state` array deep-proxies
    // its elements, so a stored element never `===` the raw object pushed here.
    openDialogs = openDialogs.filter((d) => d.id !== id);
    const session=sessions.get(id);sessions.delete(id);session?.detachCaller();session?.resolve({reason});
  }

  return {
    get openDialogs() {
      return openDialogs;
    },

    /** Register a dialog component; returns a disposer that unregisters it and
     *  closes it if currently open. */
    register(desc: DialogDescriptor): () => void {
      const dispose = registered.register(desc.id, {...desc, props: {...desc.props}});
      return () => {
        if (dispose()) close(desc.id,"owner-disposed");
      };
    },

    /** Open a registered dialog with the given props. No-op for unknown ids.
     *  Re-opening an already-open dialog replaces its props. */
    open(id: string, props: Record<string, unknown> = {}): void {
      const descriptor = registered.get(id);
      if (!descriptor) return;
      if (!releaseModal.has(id)) releaseModal.set(id, modalOwnership.register(() => close(id)));
      const instanceId=openDialogs.find(dialog=>dialog.id===id)?.instanceId??++sequence;
      openDialogs = [...openDialogs.filter((d) => d.id !== id), { id,instanceId, component:descriptor.component, props:{...props,...descriptor.props} }];
    },

    close,
    closeInstance(id:string,instanceId:number):void {if(openDialogs.some(dialog=>dialog.id===id&&dialog.instanceId===instanceId))close(id);},
    openManaged(id:string,props:Record<string,unknown>={}) {
      if (!registered.get(id)) throw new Error("Configuration dialog is unavailable; enable its plugin contribution");
      if (openDialogs.some(dialog=>dialog.id===id)) throw new Error("Configuration dialog is already open");
      const token=Symbol(id);
      let resolve!:(value:DialogResult)=>void;
      const result=new Promise<DialogResult>(done=>{resolve=done;});
      const detachCaller=modalOwnership.onCallerClosed(()=>{if(sessions.get(id)?.token===token)close(id,"caller-closed");});
      sessions.set(id,{token,resolve,detachCaller});
      const descriptor=registered.get(id)!;
      releaseModal.set(id,modalOwnership.register(()=>close(id)));
      openDialogs=[...openDialogs,{id,instanceId:++sequence,component:descriptor.component,props:{...props,...descriptor.props}}];
      return {result,close:()=>{if(sessions.get(id)?.token===token)close(id,"caller-closed");}};
    },

    /** Whether a dialog id is currently open. */
    isOpen(id: string): boolean {
      return openDialogs.some((d) => d.id === id);
    },

    /** Remove all registrations and open dialogs. Test helper. */
    clear(): void {
      registered.clear();
      for (const id of [...releaseModal.keys()]) close(id);
      openDialogs = [];
    },
  };
}

export const dialogRegistry = createDialogRegistry();
