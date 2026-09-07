import { draggedPanelWidth, panelWidth, panelWidthFromKey, type PanelWidthOptions } from "$lib/domain/panel-width";

/** A resize owns its queued frame. Retirement saves only already-published width;
 * release first flushes the final pointer position. Late cancelled frames are inert. */
export function createPanelResize(initial: unknown, options: PanelWidthOptions, deps: {
  schedule(callback: () => void): () => void;
  publish(width: number, active: boolean): void;
  persist(width: number): void;
}) {
  let width = panelWidth(initial, options);
  let drag: { initial: number; client: number; scale: number; pending?: number; stop?: () => void } | undefined;
  const publish = () => deps.publish(width, !!drag);
  function cancel() {
    const previous = drag;
    drag = undefined;
    previous?.stop?.();
    if (!previous) return;
    publish();
    if (width !== previous.initial) deps.persist(width);
  }
  function start(client: number, scale: number) {
    cancel();
    if (!Number.isFinite(client) || !Number.isFinite(scale) || scale <= 0) return false;
    drag = { initial: width, client, scale };
    publish();
    return true;
  }
  function apply(job: NonNullable<typeof drag>) {
    if (drag !== job || job.pending === undefined) return;
    width = draggedPanelWidth(job.initial, job.pending - job.client, job.scale, options);
    job.pending = undefined;
    publish();
  }
  function move(client: number) {
    const job = drag;
    if (!job || !Number.isFinite(client)) return;
    job.pending = client;
    if (job.stop) return;
    job.stop = deps.schedule(() => {
      if (drag !== job) return;
      job.stop = undefined;
      apply(job);
    });
  }
  function finish() {
    const job = drag;
    if (!job) return;
    job.stop?.(); job.stop = undefined;
    apply(job);
    if (drag === job) cancel();
  }
  function key(key: string): boolean {
    const next = panelWidthFromKey(width, key, options);
    if (next === undefined) return false;
    cancel();
    if (width !== next) { width = next; publish(); deps.persist(width); }
    return true;
  }
  return { get width() { return width; }, start, move, finish, cancel, key };
}
