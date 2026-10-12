/** Contributed dialogs retain one component instance per id/window. Pane scope
 * shares the same reservation, guarded surface and managed-session lifecycle. */
import { modalOwnership, type ModalCaller, type ModalScope } from "$lib/state/modal-ownership.svelte";
import type { PaneDialogHost } from "$lib/state/pane-dialogs.svelte";
import { createOwnedRegistry } from "$lib/state/owned-registry";
import type { PluginDialogOptions } from "./api";
import type { Component } from "svelte";

export interface DialogDescriptor {
  id: string;
  component: Component<any>;
  /** Owner-supplied dependencies, retained for cross-contribution navigation. */
  props?: Record<string, unknown>;
}
export interface OpenDialog {
  id: string;
  instanceId: number;
  component: Component<any>;
  props: Record<string, unknown>;
  scope: ModalScope;
  presentation: symbol;
  owner?: symbol;
}
export interface DialogResult { reason: "closed" | "caller-closed" | "owner-disposed" }

export function createDialogRegistry(dependencies: {
  ownership: typeof modalOwnership;
  panes?: PaneDialogHost;
} = { ownership: modalOwnership }) {
  const { ownership } = dependencies;
  let readPanes = () => dependencies.panes;
  const requirePanes = () => {
    const panes = readPanes();
    if (!panes) throw new Error("Pane dialog host is unavailable");
    return panes;
  };
  const registered = createOwnedRegistry<DialogDescriptor>();
  // Raw state preserves host-private lifetime identity (no deep proxies).
  let openDialogs = $state.raw<readonly OpenDialog[]>([]);
  const releaseModal = new Map<string, () => void>();
  const retirePane = new Map<string, () => void>();
  const sessions = new Map<string, {
    token: symbol; result: Promise<DialogResult>; resolve(value: DialogResult): void; detachCaller(): void;
  }>();
  let sequence = 0;

  function close(id: string, reason: DialogResult["reason"] = "closed"): void {
    retirePane.get(id)?.(); retirePane.delete(id);
    releaseModal.get(id)?.(); releaseModal.delete(id);
    openDialogs = openDialogs.filter(dialog => dialog.id !== id);
    const session = sessions.get(id);
    sessions.delete(id); session?.detachCaller(); session?.resolve({ reason });
  }
  function scopeFor(options?: PluginDialogOptions): ModalScope {
    return options?.scope === "pane" ? requirePanes().resolve(options.pane) : null;
  }
  function forward(dialog: OpenDialog): void {
    if (dialog.scope) requirePanes().activate(dialog.scope);
    ownership.bringForward(dialog.presentation);
  }
  function add(descriptor: DialogDescriptor, props: Record<string, unknown>, scope: ModalScope, owner?: symbol): void {
    // Activation can fail during native window closing. No reservation may
    // survive a rejected opening, even before a component has been recorded.
    if (scope) requirePanes().activate(scope);
    const dialog: OpenDialog = {
      id: descriptor.id, instanceId: ++sequence, component: descriptor.component,
      props: { ...props, ...descriptor.props }, scope, presentation: Symbol(descriptor.id), owner,
    };
    releaseModal.set(dialog.id, ownership.register(() => close(dialog.id), undefined, {
      scope, presentation: dialog.presentation, available: () => !scope || requirePanes().isVisible(scope),
    }));
    if (scope) {
      retirePane.set(dialog.id, requirePanes().onRetired(scope, () => close(dialog.id, "owner-disposed")));
    }
    openDialogs = [...openDialogs, dialog];
  }
  function managedSession(id: string, caller: ModalCaller | null) {
    const token = Symbol(id);
    let resolve!: (value: DialogResult) => void;
    const result = new Promise<DialogResult>(done => { resolve = done; });
    const session = { token, result, resolve, detachCaller: () => {} };
    sessions.set(id, session);
    session.detachCaller = caller?.onClosed(() => {
      if (sessions.get(id)?.token === token) close(id, "caller-closed");
    }) ?? (() => {});
    return session;
  }
  function sessionHandle(id: string, session: ReturnType<typeof managedSession>, ownsDialog = true) {
    return { result: session.result, ownsDialog, close: () => {
      if (ownsDialog && sessions.get(id)?.token === session.token) close(id, "caller-closed");
    } };
  }

  return {
    /** The PluginContext composition root supplies the window-owned host. */
    connectPanes(resolve: () => PaneDialogHost): void { readPanes = resolve; },
    get openDialogs() { return openDialogs; },
    register(desc: DialogDescriptor): () => void {
      const dispose = registered.register(desc.id, { ...desc, props: { ...desc.props } });
      return () => { if (dispose()) close(desc.id, "owner-disposed"); };
    },
    open(id: string, props: Record<string, unknown> = {}, options?: PluginDialogOptions, owner?: symbol): void {
      const scope = scopeFor(options); // Reject invalid captures before any mutation.
      const descriptor = registered.get(id);
      if (!descriptor) return;
      const existing = openDialogs.find(dialog => dialog.id === id);
      if (existing?.scope) { forward(existing); return; }
      if (existing) {
        // Preserve legacy window-modal reopening/props semantics.
        openDialogs = [...openDialogs.filter(dialog => dialog.id !== id), {
          ...existing, props: { ...props, ...descriptor.props },
        }];
        return;
      }
      try { add(descriptor, props, scope, owner); }
      catch (error) { close(id, "owner-disposed"); throw error; }
    },
    close,
    closeOwner(owner: symbol): void {
      // Snapshot the current instances. Reopening an id by another context
      // never lends its lifetime to the original opener's disposer.
      for (const dialog of [...openDialogs]) {
        if (dialog.owner === owner) close(dialog.id, "owner-disposed");
      }
    },
    closeOwned(id: string, owner: symbol): void {
      if (openDialogs.some(dialog => dialog.id === id && dialog.owner === owner)) close(id);
    },
    closeInstance(id: string, instanceId: number): void {
      if (openDialogs.some(dialog => dialog.id === id && dialog.instanceId === instanceId)) close(id);
    },
    openManaged(id: string, props: Record<string, unknown> = {}, options?: PluginDialogOptions, owner?: symbol) {
      const scope = scopeFor(options);
      // Capture before any destination activation/focus. A supplied handle
      // carries the original surface across the caller's asynchronous work.
      const callerPane = options?.caller ?? (options?.scope === "pane" ? options.pane : null);
      const capturedCaller = callerPane ? requirePanes().callerFor(callerPane) : null;
      const activePane = callerPane ? null : readPanes()?.capture();
      const caller = callerPane ? capturedCaller
        : ownership.captureCaller(activePane ? requirePanes().resolve(activePane) : null);
      const descriptor = registered.get(id);
      if (!descriptor) throw new Error("Configuration dialog is unavailable; enable its plugin contribution");
      const existing = openDialogs.find(dialog => dialog.id === id);
      if (existing) {
        if (!existing.scope) throw new Error("Configuration dialog is already open");
        forward(existing);
        return sessionHandle(id, sessions.get(id) ?? managedSession(id, null), existing.owner === owner);
      }
      const session = managedSession(id, caller);
      // A captured caller that retired during an await settles without opening.
      if (sessions.get(id) !== session) return sessionHandle(id, session);
      try { add(descriptor, props, scope, owner); }
      catch (error) { close(id, "owner-disposed"); throw error; }
      return sessionHandle(id, session);
    },
    isOpen(id: string): boolean { return openDialogs.some(dialog => dialog.id === id); },
    clear(): void {
      registered.clear();
      for (const dialog of [...openDialogs]) close(dialog.id);
    },
  };
}

export const dialogRegistry = createDialogRegistry();
