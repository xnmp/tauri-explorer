/** Trailing-edge debounce for the Git graph's path-filter reload (#1281).
 *
 * Pending state lives here, not in the component, so the interleaving with a
 * merge-base jump is unit-testable. A jump `defer()`s the pending reload: a
 * reload firing mid-lookup would retire the lookup (every reload does). When
 * the jump ends without revealing, `releaseDeferred()` runs the reload so the
 * graph still matches the typed filter. New input (`schedule`) or `cancel`
 * supersedes the deferral. */
export interface DebouncedReload {
  schedule(): void;
  cancel(): void;
  defer(): void;
  releaseDeferred(): void;
}

export function createDebouncedReload(reload: () => void, delayMs: number): DebouncedReload {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deferred = false;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    deferred = false;
  };
  return {
    schedule(): void {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        reload();
      }, delayMs);
    },
    cancel,
    defer(): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      deferred = true;
    },
    releaseDeferred(): void {
      if (!deferred) return;
      deferred = false;
      reload();
    },
  };
}
