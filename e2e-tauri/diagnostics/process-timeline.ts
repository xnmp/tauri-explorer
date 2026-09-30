/**
 * Process-only evidence for native WebDriver session loss.
 *
 * Retire-when: #781 closed
 *
 * WebKitWebDriver deletes its automation session when it believes a page
 * crashed or hung, after which no WebDriver command can answer anything. This
 * sampler therefore observes the local process table only: the application
 * binary, WebKit's auxiliary processes and the drivers. Renderers are
 * identified by PID plus start time, so PID reuse cannot make a dead renderer
 * appear to survive. It originated in #703 (closed; see
 * `docs/lessons/703-native-webdriver-session-loss.md`) and is kept for #781.
 */
import fs from "node:fs";
import path from "node:path";
import { parentPid, processExecutable, processIds, processStartTime } from "../native-process";

export interface ProcessObservation {
  pid: number;
  executable: string | null;
  startTime: string | null;
  parentPid: number | null;
}

export type ProcessTableReader = () => ProcessObservation[];

export interface NativeProcessEvidence {
  sampledAt: number;
  /** Processes running the exact application binary under test. */
  application: ProcessObservation[];
  /** WebKit auxiliary processes: renderer, network and GPU. */
  webkit: ProcessObservation[];
  /** `tauri-driver` and the native driver it proxies to. */
  driver: ProcessObservation[];
  /** Counts excluded from a bounded artifact sample, if any. */
  omitted?: { application: number; webkit: number; driver: number };
}

/** A failed capture is retained as `{ error }`, never treated as process absence. */
export type NativeProcessSample = NativeProcessEvidence | { error: string };

export type ProcessSampler = () => NativeProcessSample;

/** First-seen and first-missing times kept outside the rolling sample window. */
export interface RendererLifetime {
  renderer: ProcessObservation;
  firstSeenAt: number;
  firstMissingAt: number | null;
}

/** The debug binary the native suite drives. */
export const nativeApplicationBinary = path.resolve(
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "tauri-explorer.exe" : "tauri-explorer",
);

/** Store at most this many observations per process group in each timeline sample. */
export const MAX_STORED_PROCESSES_PER_GROUP = 256;
/** Track at most this many renderer identities per timeline. */
const MAX_TRACKED_RENDERERS = 256;
const SAMPLE_INTERVAL_MS = 500;

/** WebKitGTK's multi-process names. */
const WEBKIT_PROCESS_NAMES = new Set([
  "WebKitWebProcess",
  "WebKitNetworkProcess",
  "WebKitGPUProcess",
]);

const DRIVER_PROCESS_NAMES = new Set([
  "tauri-driver",
  "tauri-driver.exe",
  "WebKitWebDriver",
  "msedgedriver.exe",
]);

function basename(executable: string | null): string {
  return executable ? path.basename(executable) : "";
}

function isNativeProcessEvidence(sample: NativeProcessSample | null): sample is NativeProcessEvidence {
  return sample !== null && "sampledAt" in sample;
}

function isIdentifiableRenderer(entry: ProcessObservation): boolean {
  return basename(entry.executable) === "WebKitWebProcess" && entry.startTime !== null;
}

function sameProcess(a: ProcessObservation, b: ProcessObservation): boolean {
  return a.pid === b.pid && a.startTime === b.startTime;
}

function rendererKey(renderer: ProcessObservation): string {
  return `${renderer.pid}:${renderer.startTime}`;
}

/** Split an observed process table into application, WebKit and driver groups. */
function classifyNativeProcesses(
  table: readonly ProcessObservation[],
  applicationPath: string,
  sampledAt: number,
): NativeProcessEvidence {
  const application: ProcessObservation[] = [];
  const webkit: ProcessObservation[] = [];
  const driver: ProcessObservation[] = [];
  for (const observation of table) {
    if (observation.executable === applicationPath) application.push(observation);
    else if (WEBKIT_PROCESS_NAMES.has(basename(observation.executable))) webkit.push(observation);
    else if (DRIVER_PROCESS_NAMES.has(basename(observation.executable))) driver.push(observation);
  }
  return { sampledAt, application, webkit, driver };
}

/**
 * Observation-only `/proc` scan. It never targets a signal, so unlike
 * `exactApplicationPid` it does not require an isolated `XDG_CONFIG_HOME` and
 * tolerates several matching processes. Empty off Linux.
 */
function readLinuxProcessTable(): ProcessObservation[] {
  if (process.platform !== "linux") return [];
  return processIds().map((pid) => ({
    pid,
    executable: processExecutable(pid),
    startTime: processStartTime(pid),
    parentPid: parentPid(pid),
  }));
}

/** Sample and classify the native process table; never throws. */
export function collectNativeProcessEvidence(options: {
  applicationPath: string;
  read?: ProcessTableReader;
  now?: () => number;
}): NativeProcessSample {
  const { applicationPath, read = readLinuxProcessTable, now = Date.now } = options;
  try {
    const resolved = fs.existsSync(applicationPath)
      ? fs.realpathSync(applicationPath)
      : applicationPath;
    return classifyNativeProcesses(read(), resolved, now());
  } catch (error) {
    return { error: String(error) };
  }
}

/** The default sampler: the native suite's application binary. */
export const sampleNativeProcesses: ProcessSampler = () =>
  collectNativeProcessEvidence({ applicationPath: nativeApplicationBinary });

/**
 * Bound artifact size without changing the full process scan used for
 * liveness tracking. The newest renderers are kept; omission counts are
 * reported, because a truncated sample cannot prove a renderer is absent.
 */
export function boundNativeProcessSample(sample: NativeProcessSample): NativeProcessSample {
  if (!isNativeProcessEvidence(sample)) return sample;
  const limit = MAX_STORED_PROCESSES_PER_GROUP;
  const webkit = [...sample.webkit].sort((a, b) =>
    Number(b.startTime ?? -1) - Number(a.startTime ?? -1));
  const omitted = {
    application: Math.max(0, sample.application.length - limit),
    webkit: Math.max(0, webkit.length - limit),
    driver: Math.max(0, sample.driver.length - limit),
  };
  return {
    ...sample,
    application: sample.application.slice(0, limit),
    webkit: webkit.slice(0, limit),
    driver: sample.driver.slice(0, limit),
    ...(Object.values(omitted).some((count) => count > 0) ? { omitted } : {}),
  };
}

/**
 * The newest identifiable `WebKitWebProcess` in a sample. This is an inference
 * from process timing, not a proven PID-to-window mapping.
 */
export function newestRenderer(sample: NativeProcessSample | null): ProcessObservation | null {
  if (!isNativeProcessEvidence(sample)) return null;
  return sample.webkit
    .filter(isIdentifiableRenderer)
    .reduce<ProcessObservation | null>((newest, entry) => {
      if (!newest) return entry;
      return Number(entry.startTime) > Number(newest.startTime) ? entry : newest;
    }, null);
}

export interface ProcessTimeline {
  /** Bounded samples: the pre-operation baseline plus the newest rolling window. */
  readonly samples: NativeProcessSample[];
  /** Take one sample now, e.g. the final state after a failure. */
  sample(): void;
  /** When a tracked or focused renderer identity was first absent, if ever. */
  firstMissingAt(renderer: ProcessObservation | null): number | null;
  /** Follow one renderer even if the identity cap is already reached. */
  focusRenderer(renderer: ProcessObservation | null, firstSeenAt: number): void;
  /** Renderers visible in the first sample and when each was first absent. */
  baselineRendererDisappearances(): { renderer: ProcessObservation; firstMissingAt: number | null }[];
  /** Every tracked renderer's birth and death, including rolled-out samples. */
  observedRendererLifetimes(): RendererLifetime[];
  /** Observations the identity cap excluded from tracking. */
  untrackedRendererObservations(): number;
  /** Always call: stops the interval timer. */
  stop(): void;
}

/**
 * Sample every 500 ms for an operation expected to finish within `timeout`.
 * Samples beyond the nominal timeout keep rolling (the baseline is retained),
 * so a WebDriver command that outlives its timeout still records the
 * transition before its eventual failure. Never issues a WebDriver command.
 */
export function startProcessTimeline(options: {
  timeout: number;
  extraRenderers?: readonly ProcessObservation[];
  collect?: ProcessSampler;
}): ProcessTimeline {
  const { timeout, extraRenderers = [], collect = sampleNativeProcesses } = options;
  const samples: NativeProcessSample[] = [];
  const baselineRenderers: ProcessObservation[] = [];
  const tracked = new Map<string, RendererLifetime>();
  let focused: RendererLifetime | null = null;
  let untracked = 0;
  const maxSamples = Math.ceil(timeout / SAMPLE_INTERVAL_MS) + 2;

  const track = (renderer: ProcessObservation, firstSeenAt: number): boolean => {
    if (renderer.startTime === null) return false;
    const key = rendererKey(renderer);
    if (tracked.has(key)) return true;
    if (tracked.size >= MAX_TRACKED_RENDERERS) {
      untracked += 1;
      return false;
    }
    tracked.set(key, { renderer, firstSeenAt, firstMissingAt: null });
    return true;
  };
  extraRenderers.forEach((renderer) => track(renderer, Date.now()));

  const sample = () => {
    const observation = collect();
    if (isNativeProcessEvidence(observation)) {
      for (const renderer of observation.webkit.filter(isIdentifiableRenderer)) {
        if (track(renderer, observation.sampledAt) && samples.length === 0) {
          baselineRenderers.push(renderer);
        }
      }
      const lifetimes = focused ? [...tracked.values(), focused] : tracked.values();
      for (const state of lifetimes) {
        if (state.firstMissingAt !== null) continue;
        if (!observation.webkit.some((entry) => sameProcess(entry, state.renderer))) {
          state.firstMissingAt = observation.sampledAt;
        }
      }
    }
    if (samples.length >= maxSamples) samples.splice(1, 1);
    samples.push(boundNativeProcessSample(observation));
  };
  sample();
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref();

  const firstMissingAt = (renderer: ProcessObservation | null): number | null => {
    if (!renderer) return null;
    const trackedMissingAt = tracked.get(rendererKey(renderer))?.firstMissingAt;
    if (trackedMissingAt !== undefined) return trackedMissingAt;
    return focused && rendererKey(focused.renderer) === rendererKey(renderer)
      ? focused.firstMissingAt : null;
  };

  return {
    samples,
    sample,
    firstMissingAt,
    focusRenderer: (renderer, firstSeenAt) => {
      if (!renderer || renderer.startTime === null || tracked.has(rendererKey(renderer))) return;
      focused = { renderer, firstSeenAt, firstMissingAt: null };
    },
    baselineRendererDisappearances: () => baselineRenderers.map((renderer) => ({
      renderer,
      firstMissingAt: firstMissingAt(renderer),
    })),
    observedRendererLifetimes: () => [...tracked.values(), ...(focused ? [focused] : [])],
    untrackedRendererObservations: () => untracked,
    stop: () => clearInterval(timer),
  };
}
