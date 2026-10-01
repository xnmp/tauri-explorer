import { untrack } from "svelte";
import { createLazyDialog, type LazyDialogOptions } from "$lib/state/lazy-dialog.svelte";

/** Bind only this dialog's demand to its loader. Parent teardown owns the
 * loader; an open-flag transition must not retire a shared pending import. */
export function useLazyDialog<T>(options: LazyDialogOptions<T>, notifyError: (message: string) => void) {
  const dialog = createLazyDialog(options, notifyError);
  $effect(() => {
    if (options.isOpen()) untrack(() => { void dialog.load(); });
  });
  $effect(() => () => dialog.dispose());
  return dialog;
}
