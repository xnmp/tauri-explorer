import { clampResizeSize, draggedResizeSize, resizeSizeFromKey, type ResizeSizeOptions } from "$lib/domain/resize-size";

export interface ResizeEffects {
  schedule(callback: () => void): () => void;
  publish(value: number, active: boolean): void;
  /** Release input/activity before a durable commit can notify other owners. */
  retire(): void;
}

/** A draft belongs to one captured gesture. Only published work survives ordinary
 * interruption; a superseding source discards it. Persistence belongs to the caller. */
export function createScalarResize(deps: ResizeEffects & {
  read(): number;
  options(): ResizeSizeOptions;
  commit(value: number): void;
  /** Automatic topology changes do not supersede a captured manual gesture. */
  sourceChanges?: "supersede" | "capture";
}) {
  type Job = { source: number; value: number; initial: number; options: ResizeSizeOptions;
    client: number; scale: number; adjusted: boolean; pending?: number; stop?: () => void };
  let job: Job | undefined;
  const value = () => job?.value ?? clampResizeSize(deps.read(), deps.options());
  function superseded(current: Job) {
    const options = deps.options(), before = current.options;
    return (deps.sourceChanges !== "capture" && !Object.is(deps.read(), current.source))
      || options.min !== before.min || options.max !== before.max
      || options.default !== before.default || options.axis !== before.axis
      || options.invert !== before.invert || options.integer !== before.integer;
  }
  function retire(current: Job, commit: boolean) {
    if (job !== current) return;
    job = undefined;
    current.stop?.();
    deps.retire();
    // A DOM retirement callback can itself deliver a new external preference.
    // Check at the commit boundary, not just in a delayed reactive effect.
    if (commit && current.adjusted && !superseded(current)) deps.commit(current.value);
    if (!job) deps.publish(value(), false);
  }
  function cancel() { if (job) retire(job, true); }
  function discard() { if (job) retire(job, false); }
  function start(client: number, scale: number) {
    cancel();
    if (!Number.isFinite(client) || !Number.isFinite(scale) || scale <= 0) return false;
    const options = { ...deps.options() }, source = deps.read();
    const initial = clampResizeSize(source, options);
    job = { source, value: initial, initial, options, client, scale, adjusted: false };
    deps.publish(initial, true);
    return true;
  }
  function apply(current: Job) {
    if (job !== current || current.pending === undefined) return;
    if (superseded(current)) { retire(current, false); return; }
    const next = draggedResizeSize(current.initial, current.pending - current.client, current.scale, current.options);
    current.pending = undefined;
    current.adjusted ||= next !== current.value;
    current.value = next;
    deps.publish(next, true);
  }
  function move(client: number) {
    const current = job;
    if (!current || !Number.isFinite(client)) return;
    current.pending = client;
    if (current.stop) return;
    current.stop = deps.schedule(() => {
      if (job !== current) return;
      current.stop = undefined;
      apply(current);
    });
  }
  function finish() {
    const current = job;
    if (!current) return;
    current.stop?.(); current.stop = undefined;
    apply(current);
    if (job === current) retire(current, true);
  }
  function key(key: string) {
    reconcile();
    if (resizeSizeFromKey(value(), key, deps.options()) === undefined) return false;
    cancel();
    // Retirement may discard an obsolete draft. Step from the current source.
    const previous = value(), next = resizeSizeFromKey(previous, key, deps.options());
    if (next === undefined) return false;
    if (next !== previous) { deps.commit(next); deps.publish(value(), false); }
    return true;
  }
  /** Compare committed values, not unrelated settings-store object replacements.
   * Automatic sources opt out of value supersession; option changes still retire. */
  function reconcile() {
    if (job && superseded(job)) discard();
  }
  return { get value() { return value(); }, get axis() { return (job ? job.options.axis : deps.options().axis) ?? "x"; },
    get min() { return deps.options().min; }, get max() { return deps.options().max; },
    start, move, finish, cancel, discard, key, reconcile };
}
export type ScalarResize = ReturnType<typeof createScalarResize>;
