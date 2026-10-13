import { getContext, setContext } from "svelte";
import type { ModalScope } from "./modal-ownership.svelte";

/** Host-private context shared with the SDK's ui/modal runtime binding. */
export interface DialogPresentation {
  readonly scope: ModalScope;
  readonly presentation: symbol;
  readonly visible: boolean;
  isActive(): boolean;
  focusUncovered(): void;
}
const PRESENTATION = Symbol("host dialog presentation");
export const setDialogPresentation = (context: DialogPresentation): void => { setContext(PRESENTATION, context); };
export const getDialogPresentation = (): DialogPresentation | undefined => getContext(PRESENTATION);
