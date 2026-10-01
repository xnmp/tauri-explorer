import { loadDialogComponent, type LazyDialogRequest } from "$lib/domain/lazy-dialog";

export type LazyDialogOptions<T> = Omit<LazyDialogRequest<T>, "onLoaded"> & {
  isOpen(): boolean;
};

/** A host owns one lazy constructor, including a pending import across close /
 * reopen. Closing cancels feedback, not the browser's module fetch. Successful
 * loads remain available for synchronous reopening; disposal retires publication. */
export function createLazyDialog<T>(options: LazyDialogOptions<T>, notifyError: (message: string) => void) {
  let component = $state.raw<T | null>(null);
  let pending: Promise<void> | undefined;
  let disposed = false;

  function load(): Promise<void> {
    if (disposed || component !== null) return Promise.resolve();
    return pending ??= Promise.resolve().then(() => {
      if (disposed) return;
      let reportFailure = false;
      return loadDialogComponent({
        label: options.label,
        load: options.load,
        onLoaded: (loaded) => { if (!disposed) component = loaded; },
        onFailure: () => {
          // Capture before rollback closes the flag. Checking it again in the
          // notifier would incorrectly swallow the accepted failure's toast.
          reportFailure = !disposed && options.isOpen();
          if (reportFailure) options.onFailure?.();
        },
      }, (message) => { if (reportFailure && !disposed) notifyError(message); });
    }).finally(() => { pending = undefined; });
  }

  return {
    get component() { return component; },
    load,
    dispose() { disposed = true; component = null; },
  };
}
