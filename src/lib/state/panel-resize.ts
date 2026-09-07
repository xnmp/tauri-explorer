import { draggedPanelWidth, panelWidth, panelWidthFromKey, type PanelWidthOptions } from "$lib/domain/panel-width";

/** A resize owns its queued frame. Retirement saves only already-published width;
 * release first flushes the final pointer position. Late cancelled frames are inert. */
export function createPanelResize(initial: unknown, options: PanelWidthOptions, deps: {
  schedule(callback: () => void): () => void;
  publish(width: number, active: boolean): void;
  persist(width: number): void;
  automaticWidth?(): number;
}) {
  let preferred = typeof initial === "number" && Number.isFinite(initial)
    ? panelWidth(initial, options) : deps.automaticWidth ? undefined : panelWidth(initial, options);
  let drag: { initial: number; preference: number | undefined; client: number; scale: number; pending?: number; stop?: () => void } | undefined;
  const width = () => preferred ?? drag?.initial ?? panelWidth(deps.automaticWidth?.(), options);
  const publish = () => deps.publish(width(), !!drag);
  function cancel() {
    const previous = drag;
    const completed = preferred;
    drag = undefined;
    previous?.stop?.();
    if (!previous) return;
    publish();
    if (completed !== previous.preference && completed !== undefined) deps.persist(completed);
  }
  function start(client: number, scale: number) {
    cancel();
    if (!Number.isFinite(client) || !Number.isFinite(scale) || scale <= 0) return false;
    drag = { initial: width(), preference: preferred, client, scale };
    publish();
    return true;
  }
  function apply(job: NonNullable<typeof drag>) {
    if (drag !== job || job.pending === undefined) return;
    const next = draggedPanelWidth(job.initial, job.pending - job.client, job.scale, options);
    // A click, rejected movement or unchanged boundary keeps automatic sizing.
    if (next !== job.initial || preferred !== undefined) preferred = next;
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
    const previous = width();
    const next = panelWidthFromKey(previous, key, options);
    if (next === undefined) return false;
    cancel();
    if (previous !== next) { preferred = next; publish(); deps.persist(next); }
    return true;
  }
  return { get width() { return width(); }, start, move, finish, cancel, key };
}
