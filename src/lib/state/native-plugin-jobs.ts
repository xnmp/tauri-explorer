/** One window's owned observer. No provider RPC and no inferred terminal outcome. */
import { adoptNativeSnapshot, emptyNativeJobs, mergeNativeJobEvent, nativeJobTerminal, validNativeEvent, validNativeSnapshot, type NativeJobEvent, type NativeJobRecord, type NativeJobSnapshot } from "$lib/domain/native-plugin-jobs";
interface Dependencies {
  watch(receive: (value: unknown) => void): Promise<() => void>;
  snapshot(): Promise<NativeJobSnapshot>;
  apply(jobs: readonly NativeJobRecord[]): void;
  toast(job: NativeJobRecord): void;
  error(message: string | null): void;
}
export function createNativePluginJobsController(deps: Dependencies) {
  let view = emptyNativeJobs(), origin = "", alive = false, epoch = 0, unlisten: (() => void) | null = null;
  let loading = false, refreshTask: Promise<void> | null = null, startTask: Promise<void> | null = null;
  let watchTask: Promise<void> | null = null;
  let buffered: NativeJobEvent[] = [], overflow = false;
  const announced = new Set<string>();
  const publish = () => deps.apply([...view.jobs.values()]);
  function apply(event: NativeJobEvent, announce: boolean): void {
    const before = view;
    view = mergeNativeJobEvent(view, event);
    if (view === before) return;
    publish();
    if (announce && event.type === "updated" && nativeJobTerminal(event.job.state) && event.job.originWindow === origin
      && !nativeJobTerminal(before.jobs.get(event.job.jobKey)?.state ?? "running") && !announced.has(event.job.jobKey)) {
      announced.add(event.job.jobKey);
      if (announced.size > 1024) announced.delete(announced.values().next().value!);
      if (event.job.state === "completed" || event.job.state === "error") deps.toast(event.job);
    }
    if (view.needsSnapshot) void refresh();
  }
  function receive(value: unknown): void {
    if (!alive || !validNativeEvent(value)) return;
    if (loading) {
      if (buffered.length < 1024) buffered.push(value); else overflow = true;
    } else apply(value, true);
  }
  function ensureWatch(): Promise<void> {
    if (unlisten) return Promise.resolve();
    if (watchTask) return watchTask;
    const own = epoch;
    watchTask = (async () => {
      try {
        const stop = await deps.watch((value) => { if (epoch === own) receive(value); });
        if (!alive || epoch !== own) { stop(); return; }
        unlisten = stop;
      } finally { if (epoch === own) watchTask = null; }
    })();
    return watchTask;
  }
  function refresh(): Promise<void> {
    if (!alive) return Promise.resolve();
    if (refreshTask) return refreshTask;
    const own = epoch;
    loading = true;
    refreshTask = (async () => {
      try {
        await ensureWatch();
        if (!alive || epoch !== own) return;
        let attempts = 0;
        do {
          attempts++;
          overflow = false;
          const snapshot = await deps.snapshot();
          if (!alive || epoch !== own) return;
          if (!validNativeSnapshot(snapshot)) throw new Error("Native job snapshot is malformed");
          origin = snapshot.originWindow;
          view = adoptNativeSnapshot(view, snapshot);
          publish(); deps.error(null);
          const events = buffered; buffered = [];
          for (const event of events) apply(event, true);
        } while ((overflow || view.needsSnapshot) && attempts < 3 && alive && epoch === own);
        if (overflow || view.needsSnapshot) deps.error("Job notifications exceeded snapshot capacity. Reload job status.");
      } catch (failure) {
        if (alive && epoch === own) {
          const events = buffered; buffered = [];
          for (const event of events) apply(event, !!origin);
          deps.error(failure instanceof Error ? failure.message : "Native job status could not be loaded");
        }
      } finally {
        if (epoch === own) { loading = false; refreshTask = null; }
      }
    })();
    return refreshTask;
  }
  return {
    init(): Promise<void> {
      if (startTask) return startTask;
      alive = true;
      ++epoch;
      loading = true;
      startTask = refresh();
      return startTask;
    },
    refresh,
    has(kind: string, id: number): boolean { return [...view.jobs.values()].some((job) => job.kind === kind && job.jobId === id); },
    dispose(): void { alive = false; epoch++; unlisten?.(); unlisten = null; startTask = null; refreshTask = null; watchTask = null; loading = false; buffered = []; view = emptyNativeJobs(); announced.clear(); },
  };
}
