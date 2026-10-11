import { SvelteMap } from "svelte/reactivity";
import type { PluginDialogPane } from "$lib/plugins/api";
import type { createModalOwnership, ModalCaller, PaneModalScope } from "./modal-ownership.svelte";

/** Manager-owned identity; neither handles nor identity enter persisted state. */
export interface DialogPaneIdentity {
  readonly paneId: string;
  readonly tab: symbol;
  readonly explorer: object;
}

export function createPaneDialogHost(dependencies: {
  readPane(paneId: string): DialogPaneIdentity | null;
  activePaneId(): string;
  activeTab(): symbol | undefined;
  activate(identity: DialogPaneIdentity): void;
  ownership: ReturnType<typeof createModalOwnership>;
}) {
  type Lifetime = { owner: PaneModalScope; identity: DialogPaneIdentity; retired: Set<() => void> };
  const lifetimes = new Map<string, Lifetime>();
  const handles = new WeakMap<PluginDialogPane, { lifetime: Lifetime; caller: ModalCaller | null }>();
  type Slot = { identity: DialogPaneIdentity; element: HTMLElement; focusUncovered?: () => void };
  // DOM registration follows ExplorerPane's mount, which can outlive a
  // transient dialog scope during failed native-close recovery.
  const mountedSlots = new Map<string, Slot>();
  const slots = new SvelteMap<PaneModalScope, Slot>();
  const sameIdentity = (a: DialogPaneIdentity, b: DialogPaneIdentity) => a.tab === b.tab && a.explorer === b.explorer;
  const mounts = new Map<PaneModalScope, Set<{ container: HTMLElement; parking: HTMLElement }>>();
  const live = (lifetime: Lifetime) => {
    const current = dependencies.readPane(lifetime.identity.paneId);
    return lifetimes.get(lifetime.owner.paneId) === lifetime && current?.tab === lifetime.identity.tab
      && current.explorer === lifetime.identity.explorer;
  };

  function ownerForPane(paneId: string): PaneModalScope | null {
    const identity = dependencies.readPane(paneId);
    if (!identity) return null;
    const existing = lifetimes.get(paneId);
    if (existing && live(existing)) return existing.owner;
    if (existing) releasePane(paneId);
    const owner = Object.freeze({ paneId, token: Symbol("pane dialog lifetime") });
    lifetimes.set(paneId, { owner, identity, retired: new Set() });
    const slot = mountedSlots.get(paneId);
    if (slot && sameIdentity(slot.identity, identity)) slots.set(owner, slot);
    return owner;
  }

  function releasePane(paneId: string): void {
    const lifetime = lifetimes.get(paneId);
    if (!lifetime) return;
    lifetimes.delete(paneId); slots.delete(lifetime.owner);
    // Detach DOM and reservations before asynchronous resource destruction.
    for (const mount of mounts.get(lifetime.owner) ?? []) {
      mount.parking.append(mount.container);
    }
    for (const callback of lifetime.retired) callback();
    lifetime.retired.clear();
    dependencies.ownership.releaseScope(lifetime.owner);
  }

  const host = {
    /** Owned content may render outside the pane (for example Miller islands). */
    registerContent(paneId: string, element: HTMLElement): () => void {
      const previous = element.inert;
      const update = () => { element.inert = previous || dependencies.ownership.hasPaneOpen(paneId); };
      const unsubscribe = dependencies.ownership.subscribe(update);
      update();
      return () => { unsubscribe(); element.inert = previous; };
    },
    capture(paneId = dependencies.activePaneId()): PluginDialogPane | null {
      const identity = dependencies.readPane(paneId);
      if (!identity || identity.tab !== dependencies.activeTab()) return null;
      const owner = ownerForPane(paneId)!;
      const handle = Object.freeze({ paneId });
      handles.set(handle, { lifetime: lifetimes.get(owner.paneId)!, caller: dependencies.ownership.captureCaller(owner) });
      return handle;
    },
    resolve(handle: PluginDialogPane): PaneModalScope {
      const lifetime = handles.get(handle)?.lifetime;
      if (!lifetime || !live(lifetime)) throw new Error("Dialog pane handle is stale or belongs to another window");
      return lifetime.owner;
    },
    callerFor(handle: PluginDialogPane): ModalCaller | null {
      host.resolve(handle);
      return handles.get(handle)!.caller;
    },
    ownerForPane,
    isVisible(owner: PaneModalScope): boolean {
      const lifetime = lifetimes.get(owner.paneId);
      return lifetime?.owner === owner && live(lifetime) && lifetime.identity.tab === dependencies.activeTab();
    },
    isActive(owner: PaneModalScope): boolean {
      return host.isVisible(owner) && dependencies.activePaneId() === owner.paneId;
    },
    activate(owner: PaneModalScope): void {
      const lifetime = lifetimes.get(owner.paneId);
      if (!lifetime || lifetime.owner !== owner || !live(lifetime)) throw new Error("Dialog pane owner was disposed");
      dependencies.activate(lifetime.identity);
    },
    onRetired(owner: PaneModalScope, callback: () => void): () => void {
      const lifetime = lifetimes.get(owner.paneId);
      if (!lifetime || lifetime.owner !== owner || !live(lifetime)) throw new Error("Dialog pane owner was disposed");
      lifetime.retired.add(callback);
      return () => { lifetime.retired.delete(callback); };
    },
    slot(owner: PaneModalScope): HTMLElement | undefined { return slots.get(owner)?.element; },
    focusUncovered(owner: PaneModalScope): void {
      if (host.isActive(owner) && !dependencies.ownership.hasOpen && !dependencies.ownership.hasPaneOpen(owner.paneId)) {
        slots.get(owner)?.focusUncovered?.();
      }
    },
    focusPane(paneId: string): void {
      if (dependencies.ownership.hasOpen || dependencies.ownership.focusPane(paneId)) return;
      const owner = lifetimes.get(paneId)?.owner;
      const slot = owner ? slots.get(owner) : undefined;
      // State-first activation must also leave a previous dialog's editor, or
      // event-surface routing would continue to send B's keys to A's dialog.
      const focused = slot?.element.ownerDocument?.activeElement;
      if (focused?.closest(".pane-dialog-container")) slot?.focusUncovered?.();
    },
    registerSlot(paneId: string, slot: HTMLElement, focusUncovered?: () => void): () => void {
      const owner = ownerForPane(paneId);
      if (!owner) return () => {};
      const registration: Slot = { identity: lifetimes.get(paneId)!.identity, element: slot, focusUncovered };
      mountedSlots.set(paneId, registration);
      slots.set(owner, registration);
      for (const mount of mounts.get(owner) ?? []) slot.append(mount.container);
      return () => {
        if (mountedSlots.get(paneId) !== registration) return;
        mountedSlots.delete(paneId);
        const current = lifetimes.get(paneId);
        if (!current || !sameIdentity(current.identity, registration.identity)) return;
        slots.delete(current.owner);
        for (const mount of mounts.get(current.owner) ?? []) {
          // Parking's ancestor is hidden/inert. Do not also mutate Svelte's
          // container attributes: a same-flush remount can remain visible.
          mount.parking.append(mount.container);
        }
      };
    },
    mount(owner: PaneModalScope, container: HTMLElement, parking: HTMLElement): () => void {
      const mount = { container, parking };
      const owned = mounts.get(owner) ?? new Set();
      owned.add(mount); mounts.set(owner, owned);
      (slots.get(owner)?.element ?? parking).append(container);
      return () => {
        owned.delete(mount);
        if (!owned.size) mounts.delete(owner);
        container.remove();
      };
    },
    releasePane,
  };
  return host;
}

export type PaneDialogHost = ReturnType<typeof createPaneDialogHost>;
