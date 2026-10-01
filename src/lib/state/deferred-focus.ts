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
