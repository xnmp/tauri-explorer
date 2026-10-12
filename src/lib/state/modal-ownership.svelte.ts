/** Window ownership precedes independent pane buckets. Reservations and mounted
 * surfaces share a scope; only mounted surfaces own focus and close guards. */
export interface PaneModalScope {
  readonly paneId: string;
  readonly token: symbol;
}
export type ModalScope = PaneModalScope | null;
/** A captured caller lifetime, independent of subsequent focus/stack changes. */
export interface ModalCaller {
  readonly scope: ModalScope;
  onClosed(callback: () => void): () => void;
}
export interface ModalSurfaceOptions {
  scope?: ModalScope;
  available?: () => boolean;
  presentation?: symbol;
  element?: () => HTMLElement | null;
  focus?: () => void;
}

export function createModalOwnership() {
  type Entry = ModalSurfaceOptions & {
    scope: ModalScope;
    close: (event?: KeyboardEvent) => void;
    canClose: () => boolean;
    surface?: boolean;
    released?: Set<() => void>;
    onBlocked?: () => void;
  };
  // Cleanup reads historical rune values. Keep the live registrations outside
  // rune state so releasing an old surface cannot resurrect a reservation or
  // overwrite a surface registered earlier in the same flush.
  let entries: readonly Entry[] = [];
  let revision = $state.raw(Symbol());
  const requesting = new Set<Entry>();
  const listeners = new Set<() => void>();
  const currentEntries = () => { revision; return entries; };
  const available = (entry: Entry) => entry.available?.() ?? true;
  const inScope = (scope: ModalScope) => currentEntries().filter(entry => entry.scope === scope);
  const topSurface = (scope: ModalScope) => inScope(scope).filter(entry => entry.surface && available(entry)).at(-1);
  const hasWindow = () => currentEntries().some(entry => entry.scope === null);
  const isTop = (entry: Entry) => available(entry)
    && (entry.scope === null || !hasWindow()) && topSurface(entry.scope) === entry;
  const notify = () => { revision = Symbol(); for (const listener of listeners) listener(); };

  function release(entry: Entry): void {
    if (!entries.includes(entry)) return;
    entries = entries.filter(owner => owner !== entry);
    notify();
    for (const callback of entry.released ?? []) callback();
    entry.released?.clear();
  }

  function request(entry: Entry, event?: KeyboardEvent): void {
    if (requesting.has(entry)) return;
    if (!entry.canClose()) { entry.onBlocked?.(); return; }
    // Reservations have no draft to veto closure. Mounted surfaces retain
    // ownership until their component actually closes, including dirty guards.
    if (!entry.surface) release(entry);
    requesting.add(entry);
    try { entry.close(event); }
    catch (error) { console.error("Modal close failed:", error); }
    finally { requesting.delete(entry); }
  }

  function captureCaller(scope: ModalScope = null): ModalCaller | null {
    // Capture the requesting surface, independently of the destination pane.
    // Availability gates input, but suspended callers retain their lifetime.
    const surfaces = currentEntries().filter(entry => entry.surface);
    const focused = typeof document === "undefined" ? null : document.activeElement;
    const caller = [...surfaces].reverse().find(entry => focused && entry.element?.()?.contains(focused))
      ?? topSurface(null) ?? inScope(null).at(-1)
      ?? surfaces.filter(entry => entry.scope === scope).at(-1)
      ?? inScope(scope).at(-1);
    if (!caller) return null;
    const owners = caller.presentation
      ? currentEntries().filter(entry => entry.presentation === caller.presentation)
      : [caller];
    return {
      scope: caller.scope,
      onClosed(callback) {
        // A caller may retire during the await before the child is opened.
        // Settle immediately rather than binding to a replacement surface.
        if (owners.some(owner => !entries.includes(owner))) { callback(); return () => {}; }
        for (const owner of owners) owner.released?.add(callback);
        return () => { for (const owner of owners) owner.released?.delete(callback); };
      },
    };
  }

  return {
    /** Deliberately window-wide: pane reservations never block other panes. */
    get hasOpen(): boolean { return hasWindow(); },
    hasPaneOpen(paneId: string): boolean {
      return currentEntries().some(entry => entry.scope?.paneId === paneId && available(entry));
    },
    register(close: () => void, canClose: () => boolean = () => true, options: ModalSurfaceOptions = {}): () => void {
      const entry: Entry = { ...options, scope: options.scope ?? null, close, canClose, released: new Set() };
      entries = [...entries, entry]; notify();
      return () => release(entry);
    },
    registerSurface(close: (event?: KeyboardEvent) => void, canClose: () => boolean = () => true, onBlocked?: () => void, options: ModalSurfaceOptions = {}) {
      const entry: Entry = { ...options, scope: options.scope ?? null, close, canClose, onBlocked, surface: true, released: new Set() };
      entries = [...entries, entry]; notify();
      return {
        release: () => release(entry),
        isTop(): boolean {
          return isTop(entry);
        },
      };
    },
    /** Live input admission must precede reactive inert/hidden DOM updates. */
    ownsInput(element: Element, scope?: ModalScope): boolean {
      const owner = [...currentEntries()].reverse().find(entry => entry.surface && entry.element?.()?.contains(element));
      return !!owner && (scope === undefined || owner.scope === scope) && isTop(owner);
    },
    captureCaller,
    onCallerClosed(callback: () => void, scope: ModalScope = null): () => void {
      return captureCaller(scope)?.onClosed(callback) ?? (() => {});
    },
    /** Window first; the shared preview and body input belong to the active pane. */
    inputScope(event: Event, activePaneId: string): ModalScope | undefined {
      if (hasWindow()) return null;
      const target = event.target as HTMLElement | null;
      const surface = [...currentEntries()].reverse().find(entry => entry.surface && available(entry)
        && typeof Node !== "undefined" && target instanceof Node && entry.element?.()?.contains(target));
      if (surface) return surface.scope;
      const pane = target?.closest?.("[data-pane-id]");
      const bodyTarget = !target?.closest || (typeof document !== "undefined" && target === document.body);
      const activePaneTarget = bodyTarget || !!target?.closest?.(".preview-pane");
      const paneId = pane ? pane.getAttribute("data-pane-id") : activePaneTarget ? activePaneId : null;
      return currentEntries().find(entry => entry.scope?.paneId === paneId && available(entry))?.scope;
    },
    requestTopClose(event?: KeyboardEvent, scope: ModalScope = null): boolean {
      const effectiveScope = hasWindow() ? null : scope;
      const top = topSurface(effectiveScope) ?? inScope(effectiveScope).filter(available).at(-1);
      if (!top) return false;
      request(top, event); return true;
    },
    focusPane(paneId: string): boolean {
      if (hasWindow()) return false;
      const scope = currentEntries().find(entry => entry.scope?.paneId === paneId && available(entry))?.scope;
      const surface = scope ? topSurface(scope) : undefined;
      surface?.focus?.();
      return !!surface;
    },
    bringForward(presentation: symbol): void {
      const matching = entries.filter(entry => entry.presentation === presentation);
      entries = [...entries.filter(entry => entry.presentation !== presentation), ...matching];
      notify();
      [...matching].reverse().find(entry => entry.surface)?.focus?.();
    },
    /** Forced retirement is synchronous and bypasses draft/busy close guards. */
    releaseScope(scope: PaneModalScope): void {
      for (const entry of inScope(scope)) release(entry);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    scopeChanged: notify,
    closeAll(): void {
      const top = topSurface(null);
      if (top) { request(top); return; }
      for (const entry of inScope(null).reverse()) if (entries.includes(entry)) request(entry);
    },
  };
}

export const modalOwnership = createModalOwnership();
