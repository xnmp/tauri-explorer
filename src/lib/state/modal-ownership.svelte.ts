/** Shared input ownership for built-in and contributed modal surfaces.
 * Ownership is synchronous; count and the top token expose reactive state.
 * Mounted surfaces release themselves on unmount, after close guards finish. */
export function createModalOwnership() {
  type Entry = {
    close: (event?: KeyboardEvent) => void;
    canClose: () => boolean;
    surface?: boolean;
    token?: symbol;
    released?: Set<() => void>;
    onBlocked?: () => void;
  };
  const entries = new Set<Entry>();
  const requesting = new Set<Entry>();
  let count = $state(0);
  let topToken = $state.raw<symbol | null>(null);

  function topSurface(): Entry | undefined {
    return [...entries].filter((owner) => owner.surface).at(-1);
  }

  function release(entry: Entry): void {
    if (!entries.delete(entry)) return;
    count = entries.size;
    topToken = topSurface()?.token ?? null;
    for (const notify of entry.released ?? []) notify();
    entry.released?.clear();
  }

  function request(entry: Entry, event?: KeyboardEvent): void {
    if (requesting.has(entry)) return;
    if (!entry.canClose()) {
      entry.onBlocked?.();
      return;
    }
    // A pre-mount reservation has no draft to veto closure. Detach it before
    // invoking a potentially reentrant registry callback. A mounted surface
    // keeps ownership until its component really closes and unmounts.
    if (!entry.surface) release(entry);
    requesting.add(entry);
    try {
      entry.close(event);
    } catch (error) {
      console.error("Modal close failed:", error);
    } finally {
      requesting.delete(entry);
    }
  }

  return {
    get hasOpen(): boolean { return count > 0; },
    register(close: () => void, canClose: () => boolean = () => true): () => void {
      const entry = { close, canClose };
      entries.add(entry);
      count = entries.size;
      return () => release(entry);
    },
    /** Reservations gate input before mount; mounted surfaces own focus. */
    registerSurface(close: (event?: KeyboardEvent) => void, canClose: () => boolean = () => true, onBlocked?: () => void) {
      const entry = { close, canClose, onBlocked, surface: true, token: Symbol("modal surface"), released: new Set<() => void>() };
      entries.add(entry);
      count = entries.size;
      topToken = entry.token;
      return { release: () => release(entry), isTop(): boolean { return topToken === entry.token; } };
    },
    onCallerClosed(notify: () => void): () => void {
      const caller = topSurface();
      if (!caller?.released) return () => {};
      caller.released.add(notify);
      return () => caller.released?.delete(notify);
    },
    /** True means a modal owns this request, including a busy/dirty veto. */
    requestTopClose(event?: KeyboardEvent): boolean {
      const top = topSurface() ?? [...entries].at(-1);
      if (!top) return false;
      request(top, event);
      return true;
    },
    closeAll(): void {
      const top = topSurface();
      if (top) {
        // onClose may show confirmation instead of closing. Never advance to
        // its reservation or suspended caller until that surface unmounts.
        request(top);
        return;
      }
      for (const entry of [...entries].reverse()) {
        if (entries.has(entry)) request(entry);
      }
    },
  };
}

export const modalOwnership = createModalOwnership();
