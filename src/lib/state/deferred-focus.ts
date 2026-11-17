export interface DeferredFocusRequest {
  consume(): boolean;
  cancel(): void;
}

/** A one-shot focus request belongs to the initiating interaction, not to
 * completion of a lazy import. A newer interaction permanently retires it. */
export function createDeferredFocusRequest(events: EventTarget, isCurrent: () => boolean): DeferredFocusRequest {
  let pending = true;
  const cancel = () => {
    if (!pending) return;
    pending = false;
    events.removeEventListener("keydown", cancel, true);
    events.removeEventListener("pointerdown", cancel, true);
    events.removeEventListener("blur", cancel);
  };
  events.addEventListener("keydown", cancel, true);
  events.addEventListener("pointerdown", cancel, true);
  events.addEventListener("blur", cancel);
  return {
    cancel,
    consume() {
      const accepted = pending && isCurrent();
      cancel();
      return accepted;
    },
  };
}

/** The part of a focus owner `focusStillOwned` inspects. */
export interface FocusOwner {
  readonly isConnected: boolean;
  closest(selector: string): unknown;
}

/** Whether focus still belongs to `previous`, the owner when a request began:
 * it still has focus, or it can no longer hold focus — removed, or inside an
 * inert subtree such as a retained (hidden) tab (#1173, #1729) — and focus fell
 * to the body with it. Any other move of focus is a newer owner's. */
export function focusStillOwned(previous: FocusOwner | null, active: unknown, body: unknown): boolean {
  if (active === previous) return true;
  return !!previous && active === body && (!previous.isConnected || previous.closest("[inert]") !== null);
}
