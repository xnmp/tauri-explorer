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
}

export interface OpenDialog {
  id: string;
  component: Component<any>;
  props: Record<string, unknown>;
}

function createDialogRegistry() {
  // Registered dialogs are looked up on open; a plain Map (no reactivity) is
  // enough since only the *open* set drives rendering.
  const registered = createOwnedRegistry<Component<any>>();
  let openDialogs = $state<OpenDialog[]>([]);
  const releaseModal = new Map<string, () => void>();

  function close(id: string): void {
    releaseModal.get(id)?.();
    releaseModal.delete(id);
    // Remove by id, not object reference: Svelte's `$state` array deep-proxies
    // its elements, so a stored element never `===` the raw object pushed here.
    openDialogs = openDialogs.filter((d) => d.id !== id);
  }

  return {
    get openDialogs() {
      return openDialogs;
    },

    /** Register a dialog component; returns a disposer that unregisters it and
     *  closes it if currently open. */
    register(desc: DialogDescriptor): () => void {
      const dispose = registered.register(desc.id, desc.component);
      return () => {
        if (dispose()) close(desc.id);
      };
    },

    /** Open a registered dialog with the given props. No-op for unknown ids.
     *  Re-opening an already-open dialog replaces its props. */
    open(id: string, props: Record<string, unknown> = {}): void {
      const component = registered.get(id);
      if (!component) return;
      if (!releaseModal.has(id)) releaseModal.set(id, modalOwnership.register(() => close(id)));
      openDialogs = [...openDialogs.filter((d) => d.id !== id), { id, component, props }];
    },

    close,

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
