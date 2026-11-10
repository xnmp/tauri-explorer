import type { Slot } from "$lib/domain/request-slot";

/**
 * Reactive home for one request slot (#1569).
 *
 * Store commands (`begin`, `settle`, `clear`) must read the slot WITHOUT
 * subscribing: a command called inside a tracked `$effect` that also wrote the
 * slot would re-run that effect. So the authoritative value is a plain
 * variable (`get`, never tracked) and a separate raw signal (`view`) is
 * published on every change for getters to build `$derived` values over. A
 * getter built that way notifies only when its own value changes, not when a
 * reload begins.
 */
export interface SlotCell<S extends Slot<never, never, never> | Slot<unknown, unknown, unknown>> {
  /** Current slot, untracked. For commands and settle checks. */
  get(): S;
  /** Replace the slot; identical values publish nothing. */
  set(next: S): void;
  /** Current slot, tracked. For `$derived` getters and guards the old code read reactively. */
  view(): S;
}

export function createSlotCell<S extends Slot<never, never, never> | Slot<unknown, unknown, unknown>>(initial: S): SlotCell<S> {
  let current = initial;
  let published = $state.raw(initial);
  return {
    get: () => current,
    set(next) {
      if (next === current) return;
      current = next;
      published = next;
    },
    view: () => published,
  };
}
