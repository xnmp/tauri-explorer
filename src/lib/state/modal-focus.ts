import type { DialogPresentation } from "./dialog-presentation-context";

export function canRestoreModalFocus(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[inert], [aria-hidden='true']")) return false;
  if (element.matches(":disabled")) return false;
  return element === element.ownerDocument.body || element.offsetParent !== null;
}

/** Restore only within the still-active owner after scoped ownership and inert
 * content have been released. A captured opening can have observed B's focus. */
export function createPaneDialogFocusRestore(
  ref: HTMLElement,
  previous: HTMLElement | null,
  paneId: string,
  presentation: Pick<DialogPresentation, "isActive" | "focusUncovered"> & { isUncovered(): boolean },
): () => void {
  const document = ref.ownerDocument;
  // Svelte may detach the focused subtree before effect cleanup. Retain the
  // latest focus owner, including moves outside the dialog and explicit blur,
  // so body focus caused by removal still belongs to the closing surface.
  let focused: Node | null = document.activeElement;
  const focusIn = (event: FocusEvent) => { focused = event.target as Node | null; };
  const focusOut = (event: FocusEvent) => {
    if (event.target === focused && focused?.isConnected) focused = event.relatedTarget as Node | null;
  };
  document.addEventListener("focusin", focusIn, true);
  document.addEventListener("focusout", focusOut, true);
  return () => {
    document.removeEventListener("focusin", focusIn, true);
    document.removeEventListener("focusout", focusOut, true);
    const current = document.activeElement;
    const removedFocus = current === document.body && focused !== null
      && !focused.isConnected && ref.contains(focused);
    if (!presentation.isActive() || (!ref.contains(current) && !removedFocus)) return;
    queueMicrotask(() => {
      const current = document.activeElement;
      if (!presentation.isActive() || !presentation.isUncovered()
        || (current !== document.body && !ref.contains(current))) return;
      if (previous?.closest("[data-pane-id]")?.getAttribute("data-pane-id") === paneId && canRestoreModalFocus(previous)) previous.focus();
      else presentation.focusUncovered();
    });
  };
}
