/**
 * Slow directory-load watchdog (#1022).
 *
 * An in-flight registry of directory loads. Each load arms one timer at the
 * threshold; if the load is still pending when it fires, its trace is
 * recorded *while stuck*, so a load that never finishes still says where it
 * is waiting. A recorded load is recorded again when it settles, replacing
 * the pending record with its outcome. Fast loads cost a trace object, a few
 * clock reads and one timer that is cleared on completion.
 *
 * Recording is best-effort and never throws into the load it observes.
 */
import {
  SLOW_LOAD_THRESHOLD_MS,
  buildFrontendRecord,
  enterPhase,
  finishLoadTrace,
  formatTraceId,
  noteEntries,
  noteQueuedBehind,
  recordOnFinish,
  retarget,
  startLoadTrace,
  type FrontendLoadPhase,
  type FrontendSlowLoadRecord,
  type LoadOutcome,
  type LoadTrace,
  type LoadTraceInit,
  type QueuedBehind,
} from "$lib/domain/load-diagnostics";
import { recordSlowLoad } from "$lib/api/load-diagnostics";

/** The narrow surface the listing pipeline sees. */
export interface LoadTraceHandle {
  readonly id: string;
  /** Monotonic start, for loads queued behind this one. */
  readonly startedMono: number;
  phase(phase: FrontendLoadPhase): void;
  /** The load now lists `path` (auto-enter descended to it). */
  retarget(path: string): void;
  queuedBehind(blocker: QueuedBehind | null): void;
  entries(count: number): void;
  finish(outcome: LoadOutcome): void;
}

export interface LoadWatchdogDeps {
  nowMono(): number;
  nowEpoch(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  persist(record: FrontendSlowLoadRecord): Promise<void>;
  randomSuffix(): string;
  thresholdMs?: number;
  sinceBootMs?(): number | null;
}

interface Entry {
  trace: LoadTrace;
  timer: unknown;
  recorded: boolean;
}

type DriveKindResolver = (path: string) => string | null;

const MAX_IN_FLIGHT = 64;

export function createLoadWatchdog(deps: LoadWatchdogDeps) {
  const threshold = deps.thresholdMs ?? SLOW_LOAD_THRESHOLD_MS;
  const inFlight = new Map<string, Entry>();
  let driveKindFor: DriveKindResolver = () => null;
  let sequence = 0;

  /** Unique within this page (sequence) and across windows (random prefix). */
  function nextId(): string {
    sequence = (sequence + 1) % 36 ** 8;
    return formatTraceId(deps.nowEpoch(), `${deps.randomSuffix().slice(0, 8)}${sequence.toString(36)}`);
  }

  function persist(entry: Entry): void {
    let record: FrontendSlowLoadRecord;
    try {
      let driveKind: string | null = null;
      try { driveKind = driveKindFor(entry.trace.path); } catch { /* optional context */ }
      record = buildFrontendRecord(entry.trace, {
        nowMono: deps.nowMono(),
        nowEpoch: deps.nowEpoch(),
        thresholdMs: threshold,
        driveKind,
        sinceBootMs: deps.sinceBootMs?.() ?? null,
        others: [...inFlight.values()].map((other) => other.trace),
      });
    } catch {
      return;
    }
    entry.recorded = true;
    try {
      void deps.persist(record).catch(() => undefined);
    } catch {
      // The sink is best-effort.
    }
  }

  function update(id: string, change: (trace: LoadTrace) => LoadTrace): void {
    const entry = inFlight.get(id);
    if (entry) entry.trace = change(entry.trace);
  }

  function begin(init: Omit<LoadTraceInit, "id">): LoadTraceHandle {
    const trace = startLoadTrace({ ...init, id: nextId() }, deps.nowMono(), deps.nowEpoch());
    const entry: Entry = { trace, timer: null, recorded: false };
    inFlight.set(trace.id, entry);
    // Owners settle their traces; this bound only guards against a leak.
    for (const [id, stale] of inFlight) {
      if (inFlight.size <= MAX_IN_FLIGHT) break;
      if (stale.timer !== null) deps.clearTimer(stale.timer);
      inFlight.delete(id);
    }
    // Fires while the load is still pending: this is the capture that
    // survives a load that never finishes.
    entry.timer = deps.setTimer(() => {
      entry.timer = null;
      if (inFlight.get(trace.id) === entry) persist(entry);
    }, threshold);

    return {
      id: trace.id,
      startedMono: trace.startedMono,
      phase: (phase) => update(trace.id, (current) => enterPhase(current, phase, deps.nowMono())),
      retarget: (path) => update(trace.id, (current) => retarget(current, path)),
      queuedBehind: (blocker) => update(trace.id, (current) => noteQueuedBehind(current, blocker)),
      entries: (count) => update(trace.id, (current) => noteEntries(current, count)),
      finish: (outcome) => {
        if (inFlight.get(trace.id) !== entry) return;
        if (entry.timer !== null) deps.clearTimer(entry.timer);
        entry.timer = null;
        entry.trace = finishLoadTrace(entry.trace, outcome, deps.nowMono());
        if (recordOnFinish(entry.trace, entry.recorded, threshold)) persist(entry);
        inFlight.delete(trace.id);
      },
    };
  }

  return {
    begin,
    /** A fresh trace ID for a listing that is not itself watched. */
    mintTraceId: nextId,
    /** Traces still in flight, for diagnostics and tests. */
    inFlight: (): LoadTrace[] => [...inFlight.values()].map((entry) => entry.trace),
    /** Resolve the drive kind (removable, network, …) of a path at record time. */
    setDriveKindResolver(resolver: DriveKindResolver): void {
      driveKindFor = resolver;
    },
  };
}

function sinceBoot(): number | null {
  if (typeof window === "undefined" || typeof performance === "undefined") return null;
  const boot = (window as { __BOOT_T0__?: number }).__BOOT_T0__;
  return typeof boot === "number" ? performance.now() - boot : null;
}

export const loadWatchdog = createLoadWatchdog({
  nowMono: () => performance.now(),
  nowEpoch: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  persist: recordSlowLoad,
  randomSuffix: () => Math.random().toString(36).slice(2, 10),
  sinceBootMs: sinceBoot,
});
