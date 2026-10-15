import { invoke, isTauri } from "$lib/api/common";

export interface DragClockSample { id: string; now: number }

/** Correlate native Instant with performance.now once per renderer. IPC latency
 * is retained as an uncertainty interval; never compare unrelated clock realms. */
export function createDragClock(readSample: () => Promise<DragClockSample>, performanceClock: () => Pick<Performance, "now" | "timeOrigin"> = () => performance) {
  let sample: { id: string; offset: number; uncertainty: number } | undefined;
  let pending: Promise<void> | undefined;
  return {
    initialize(): Promise<void> {
      if (pending) return pending;
      const before = performanceClock().now();
      pending = readSample().then(value => {
        const after = performanceClock().now();
        if (!value || typeof value.id !== "string" || !value.id || !Number.isFinite(value.now) || value.now < 0) throw new Error("Invalid drag clock sample");
        // Native sampled between request and response. The lower bound plus
        // elapsed performance time cannot run ahead of its native counterpart.
        sample = { id: value.id, offset: value.now - after, uncertainty: Math.max(0, after - before) + 1 };
      }).catch(error => { pending = undefined; throw error; });
      return pending;
    },
    stamp() {
      const clock = performanceClock();
      return sample ? { clockId: sample.id, at: Math.floor(sample.offset + clock.now()), uncertainty: Math.ceil(sample.uncertainty) }
        : { clockId: `browser:${clock.timeOrigin}`, at: Math.floor(clock.timeOrigin + clock.now()), uncertainty: 0 };
    },
    get ready() { return !!sample || !isTauri(); },
  };
}

export const dragClock = createDragClock(() => invoke<DragClockSample>("native_file_drag_clock"));
