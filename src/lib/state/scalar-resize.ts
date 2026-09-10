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
  let disposed = false, inputRevision = 0;
  // Reads project current presentation immediately; cleanup remains in the
  // explicit mutation paths, so observing a superseded draft has no side effects.
  const value = () => job && !superseded(job) ? job.value : clampResizeSize(deps.read(), deps.options());
  function superseded(current: Job) {
    const options = deps.options(), before = current.options;
    return (deps.sourceChanges !== "capture" && !Object.is(deps.read(), current.source))
      || options.min !== before.min || options.max !== before.max
      || options.default !== before.default || options.axis !== before.axis
      || options.invert !== before.invert || options.integer !== before.integer
      || options.zeroIsDefault !== before.zeroIsDefault;
  }
  function release(current: Job) {
    if (job !== current) return false;
    job = undefined;
    current.stop?.();
    deps.retire();
    return true;
  }
  function commitDraft(current: Job) {
    if (current.adjusted && !superseded(current)) deps.commit(current.value);
  }
  function retireJob(current: Job, commit: boolean) {
    if (!release(current)) return;
    // Retirement itself can deliver a new preference. Validate at the write.
    if (commit) commitDraft(current);
    if (!job && !disposed) deps.publish(value(), false);
  }
  /** Release now, then conditionally finalize once outside the caller's teardown
   * context. Reads during framework teardown may expose historical state. A new
   * input supersedes this completion; a disposed owner never publishes again. */
  function retire() {
    const current = job, revision = inputRevision;
    if (!current || !release(current)) return;
    if (!disposed && !job) deps.publish(value(), false);
    let pending = true;
    return () => {
      if (!pending) return;
      pending = false;
      if (revision !== inputRevision) return;
      commitDraft(current);
      if (!disposed && !job && revision === inputRevision) deps.publish(value(), false);
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    return retire();
  }
  function cancel() { if (job) retireJob(job, true); }
  function discard() { if (job) retireJob(job, false); }
  function start(client: number, scale: number) {
    if (disposed) return false;
    inputRevision += 1;
    cancel();
    if (disposed) return false;
    if (!Number.isFinite(client) || !Number.isFinite(scale) || scale <= 0) return false;
    const options = { ...deps.options() }, source = deps.read();
    const initial = clampResizeSize(source, options);
    const current: Job = { source, value: initial, initial, options, client, scale, adjusted: false };
    job = current;
    deps.publish(initial, true);
    return !disposed && job === current;
  }
  function apply(current: Job) {
    if (job !== current || current.pending === undefined) return;
    if (superseded(current)) { retireJob(current, false); return; }
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
    if (job === current) retireJob(current, true);
  }
  function key(key: string) {
    if (disposed) return false;
    reconcile();
    if (resizeSizeFromKey(value(), key, deps.options()) === undefined) return false;
    inputRevision += 1;
    cancel();
    if (disposed) return true; // The accepted key retired its owner; do not route it elsewhere.
    // Retirement may discard an obsolete draft. Step from the current source.
    const previous = value(), next = resizeSizeFromKey(previous, key, deps.options());
    if (next === undefined) return false;
    if (next !== previous) {
      const revision = inputRevision;
      deps.commit(next);
      if (!disposed && !job && revision === inputRevision) deps.publish(value(), false);
    }
    return true;
  }
  /** Compare committed values, not unrelated settings-store object replacements.
   * Automatic sources opt out of value supersession; option changes still retire. */
  function reconcile() {
    if (job && superseded(job)) discard();
  }
  return { get value() { return value(); }, get axis() { return (job ? job.options.axis : deps.options().axis) ?? "x"; },
    get min() { return deps.options().min; }, get max() { return deps.options().max; },
    start, move, finish, cancel, discard, key, reconcile, retire, dispose };
}
export type ScalarResize = ReturnType<typeof createScalarResize>;
