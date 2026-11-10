/** Cooperative materialization of a restored layout. Pane sessions own the
 * resources; this owner only controls when their reserved factories may run. */
export type PaneActivationScheduler = (callback: () => void) => () => void;
export const PANE_ACTIVATION_BATCH_SIZE = 4;

/** Leave a paint opportunity before each bounded batch. The task fallback is
 * for nonvisual hosts; browser restoration always follows animation frames. */
export const schedulePaneActivation: PaneActivationScheduler = (callback) => {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(callback); });
  return () => cancelAnimationFrame(frame);
};

export function createPaneActivationQueue(dependencies: {
  isPending(paneId: string): boolean;
  activate(paneId: string): void;
  schedule?: PaneActivationScheduler;
}) {
  const schedule = dependencies.schedule ?? schedulePaneActivation;
  let current: { ids: string[]; index: number; stop?: () => void } | undefined;

  function cancel(): void {
    const previous = current;
    current = undefined;
    previous?.stop?.();
  }

  function request(paneIds: readonly string[], focusedPaneId: string): void {
    cancel();
    const ids = paneIds.filter(dependencies.isPending);
    if (ids.length <= PANE_ACTIVATION_BATCH_SIZE) {
      for (const id of ids) dependencies.activate(id);
      return;
    }
    // Focus is immediately usable, even when it is last in a huge saved tree.
    dependencies.activate(focusedPaneId);
    const job = { ids: ids.filter((id) => id !== focusedPaneId), index: 0, stop: undefined as (() => void) | undefined };
    current = job;
    const run = () => {
      if (current !== job) return;
      job.stop = undefined;
      let activated = 0;
      try {
        while (current === job && job.index < job.ids.length && activated < PANE_ACTIVATION_BATCH_SIZE) {
          const id = job.ids[job.index++];
          if (!dependencies.isPending(id)) continue;
          activated++;
          dependencies.activate(id);
        }
      } finally {
        if (current === job) {
          if (job.index < job.ids.length) job.stop = schedule(run);
          else current = undefined;
        }
      }
    };
    job.stop = schedule(run);
  }

  return { request, cancel };
}
