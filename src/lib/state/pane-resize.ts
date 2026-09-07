import type { SplitDirection } from "$lib/domain/pane-layout";

interface ResizeTarget {
  direction: SplitDirection;
  start: number;
  extent: number;
  commit(ratio: number): boolean;
}

/** Owns one pointer drag and its coalesced frame, independently of live props. */
export function createPaneResize(dependencies: {
  schedule(callback: () => void): () => void;
  publishActive(active: boolean): void;
}) {
  let current: { target: ResizeTarget; pending?: number; stop?: () => void } | undefined;

  function cancel(): void {
    const previous = current;
    current = undefined;
    previous?.stop?.();
    if (previous) dependencies.publishActive(false);
  }

  function start(target: ResizeTarget): void {
    cancel();
    if (!Number.isFinite(target.start) || !Number.isFinite(target.extent) || target.extent <= 0) return;
    current = { target };
    dependencies.publishActive(true);
  }

  function apply(job: NonNullable<typeof current>): void {
    if (current !== job || job.pending === undefined) return;
    const ratio = (job.pending - job.target.start) / job.target.extent;
    job.pending = undefined;
    if (!Number.isFinite(ratio)) return;
    const accepted = job.target.commit(ratio);
    if (!accepted && current === job) cancel();
  }

  function move(clientX: number, clientY: number): void {
    const job = current;
    if (!job) return;
    const client = job.target.direction === "row" ? clientX : clientY;
    if (!Number.isFinite(client)) return;
    job.pending = client;
    if (job.stop) return;
    job.stop = dependencies.schedule(() => {
      if (current !== job) return;
      job.stop = undefined;
      apply(job);
    });
  }

  function finish(): void {
    const job = current;
    if (!job) return;
    job.stop?.();
    job.stop = undefined;
    apply(job);
    if (current === job) cancel();
  }

  return { start, move, finish, cancel };
}
