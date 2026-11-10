/**
 * Latest-request-wins slot (#1569).
 *
 * One async result a store owns: idle, loading, ready or failed. A request is
 * identified by the token it began with; only the newest `begin` can settle,
 * so superseded and cleared requests drop their late results by construction.
 * Every transition is pure, and `settle` returns the SAME slot object when the
 * result is stale (the `settleAiFilter` contract), so callers can detect
 * "nothing happened" by identity.
 *
 * `T` must not include `undefined`: `slotData` uses `undefined` for "no data".
 *
 * Tokens only need to be unique per `begin` within a slot; a store mints them
 * from one counter shared by its slots. Invalidating a slot (close, dispose,
 * invalidate) is `clearSlot` - it needs no counter bump because an idle slot
 * accepts no settle.
 */

export type Slot<T, K = undefined, E = string> =
  | { readonly kind: "idle" }
  /** `previous` is the last ready data, kept visible while a reload runs. */
  | { readonly kind: "loading"; readonly key: K; readonly token: number; readonly previous: T | undefined }
  | { readonly kind: "ready"; readonly key: K; readonly data: T }
  /** `previous` is set only when the failure opted in with `keepPrevious`. */
  | { readonly kind: "failed"; readonly key: K; readonly error: E; readonly previous: T | undefined };

export type SlotOutcome<T, E = string> =
  | { readonly ok: true; readonly data: T }
  /** `keepPrevious`: the failed reload keeps showing the data it replaced. */
  | { readonly ok: false; readonly error: E; readonly keepPrevious?: boolean };

const IDLE_SLOT: Slot<never, never, never> = Object.freeze({ kind: "idle" });

export const idleSlot = <T, K = undefined, E = string>(): Slot<T, K, E> => IDLE_SLOT;

const readySlot = <T, K, E = string>(key: K, data: T): Slot<T, K, E> => ({ kind: "ready", key, data });

/** Start a request. Supersedes any request in flight; keeps shown data as `previous`. */
export function beginSlot<T, K, E>(slot: Slot<T, K, E>, key: K, token: number): Slot<T, K, E> {
  return { kind: "loading", key, token, previous: slotData(slot) };
}

/** Apply a result for `token`. Returns `slot` itself (identity) when stale. */
export function settleSlot<T, K, E>(slot: Slot<T, K, E>, token: number, outcome: SlotOutcome<T, E>): Slot<T, K, E> {
  if (slot.kind !== "loading" || slot.token !== token) return slot;
  return outcome.ok
    ? { kind: "ready", key: slot.key, data: outcome.data }
    : { kind: "failed", key: slot.key, error: outcome.error, previous: outcome.keepPrevious ? slot.previous : undefined };
}

/** Whether `token` is still the request in flight (for mid-request re-checks). */
export const isSlotCurrent = (slot: Slot<unknown, unknown, unknown>, token: number): boolean =>
  slot.kind === "loading" && slot.token === token;

/**
 * Revoke the request in flight but keep what was being shown: back to ready
 * with the previous data, or idle when there was none. Other states are returned as is.
 */
export function cancelSlot<T, K, E>(slot: Slot<T, K, E>): Slot<T, K, E> {
  if (slot.kind !== "loading") return slot;
  return slot.previous === undefined ? idleSlot<T, K, E>() : readySlot<T, K, E>(slot.key, slot.previous);
}

/** Drop data and revoke any request in flight. */
export function clearSlot<T, K, E>(slot: Slot<T, K, E>): Slot<T, K, E> {
  return slot.kind === "idle" ? slot : idleSlot<T, K, E>();
}

export const isSlotLoading = (slot: Slot<unknown, unknown, unknown>): boolean => slot.kind === "loading";

/** Data to show: ready data, or the previous data while loading / after a keepPrevious failure. */
export function slotData<T, K, E>(slot: Slot<T, K, E>): T | undefined {
  switch (slot.kind) {
    case "ready": return slot.data;
    case "loading":
    case "failed": return slot.previous;
    case "idle": return undefined;
  }
}
