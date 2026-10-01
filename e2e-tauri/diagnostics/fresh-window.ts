/**
 * Fresh-child-window evidence for native WebDriver session loss.
 *
 * Retire-when: #781 closed
 *
 * The session can be lost while launching a fresh child, while selecting its
 * handle, while snapshotting its page, or on its first element lookup. Each
 * phase starts a process-only timeline before the WebDriver work and, on
 * failure, writes one JSON record to `e2e-tauri/logs/fresh-window/` without
 * issuing another WebDriver command. Success writes only the `selected`
 * record, which a later lookup failure replays. Diagnostics never change the
 * outcome: the original error is always rethrown by the caller.
 *
 * Started for #703 (closed, `docs/lessons/703-native-webdriver-session-loss.md`);
 * extended to selection and launch for #781
 * (`docs/lessons/781-fresh-window-selection-diagnostics.md`).
 */
import { browser } from "@wdio/globals";
import { diagnosticsDirectory, hashedArtifactName, writeDiagnosticArtifact } from "./artifact";
import {
  boundNativeProcessSample,
  newestRenderer,
  sampleNativeProcesses,
  startProcessTimeline,
  type NativeProcessSample,
  type ProcessObservation,
  type ProcessSampler,
  type RendererLifetime,
} from "./process-timeline";

/** One renderer-side sample, taken atomically in a single `browser.execute`. */
export interface FreshWindowPageSnapshot {
  capturedAt: number;
  label: string | null;
  hooksReady: boolean;
  fileListCount: number;
  entryCount: number;
  statusPath: string | null;
  url: string;
  readyState: string;
  visibility: string;
}

interface RendererTimelineSummary {
  /** First missing time is retained even if its sample ages out of the rolling window. */
  baselineRendererDisappearances: readonly { renderer: ProcessObservation; firstMissingAt: number | null }[];
  /** Includes renderers first seen after the phase started, even if their samples roll out. */
  observedRendererLifetimes: readonly RendererLifetime[];
  /** Explicitly shows if the bounded identity tracker could not include every process. */
  untrackedRendererObservations: number;
}

/** A launch can lose the driver session before returning the child label. */
interface FreshWindowOpenFailure extends RendererTimelineSummary {
  issue: 781;
  phase: "open-failed";
  requestedLabel: string;
  openStartedAt: number;
  openFailedAt: number;
  openError: string;
  nativeBeforeOpen: NativeProcessSample;
  nativeDuringOpen: readonly NativeProcessSample[];
}

/** A selection failure can occur before any child page or renderer is known. */
interface FreshWindowSelectionFailure extends RendererTimelineSummary {
  issue: 781;
  phase: "selection-failed";
  requestedLabel: string;
  selectionStartedAt: number;
  selectionFailedAt: number;
  selectionError: string;
  existingHandles: readonly string[];
  nativeBeforeSelection: NativeProcessSample;
  nativeDuringSelection: readonly NativeProcessSample[];
}

/** Written at selection, then replayed with lookup evidence if the first lookup fails. */
interface FreshWindowSelected {
  issue: 781;
  phase: "selected" | "lookup-failed";
  requestedLabel: string;
  handle: string;
  selectedAt: number;
  /** Renderer sample taken at successful fresh-handle selection. */
  pageAtSelection: FreshWindowPageSnapshot | { error: string } | null;
  nativeAtSelection: NativeProcessSample | null;
  /** Selection is persisted before the page snapshot, then updated when it settles. */
  nativeDuringPageSnapshot?: NativeProcessSample[];
  pageSnapshotRendererFirstMissingAt?: number | null;
  /** Only on a failed lookup; the session may already be invalid. */
  lookup?: { selector: string; startedAt: number; failedAt: number; error: string };
  nativeAfterFailure?: NativeProcessSample;
  /** Bounded, process-only samples captured while the WebDriver command was pending. */
  nativeDuringLookup?: NativeProcessSample[];
  /** The newest renderer at selection is the fresh child's best observable identity. */
  selectedRendererAtSelection?: ProcessObservation | null;
  /** First sample where that exact PID/start-time identity was absent. */
  selectedRendererFirstMissingAt?: number | null;
}

type FreshWindowRecord = FreshWindowOpenFailure | FreshWindowSelectionFailure | FreshWindowSelected;

function recordTimestamp(record: FreshWindowRecord): number {
  switch (record.phase) {
    case "open-failed": return record.openStartedAt;
    case "selection-failed": return record.selectionStartedAt;
    default: return record.selectedAt;
  }
}

function writeRecord(record: FreshWindowRecord): string | null {
  return writeDiagnosticArtifact(
    diagnosticsDirectory("fresh-window"),
    hashedArtifactName(recordTimestamp(record), record.requestedLabel, record.phase),
    record,
  );
}

/** Evidence for the most recent successful selection; cleared when a new one starts. */
let lastSelection: FreshWindowSelected | null = null;

/**
 * One atomic renderer sample. WebKitWebDriver may evaluate injected scripts in
 * an isolated world, so read DOM state only — never application globals.
 */
async function captureFreshWindowPage(): Promise<FreshWindowPageSnapshot | { error: string }> {
  try {
    return await browser.execute(() => {
      const data = document.documentElement.dataset;
      const status = document.querySelector(".status-path");
      return {
        capturedAt: Date.now(),
        label: data.e2eWindowLabel ?? null,
        hooksReady: data.e2eHooksReady === "true",
        fileListCount: document.querySelectorAll(".file-list").length,
        entryCount: document.querySelectorAll(".entry-item").length,
        statusPath: status ? status.getAttribute("title") : null,
        url: location.href,
        readyState: document.readyState,
        visibility: document.visibilityState,
      };
    }) as FreshWindowPageSnapshot;
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Run a fresh-window launch, retaining the planned label and a process
 * timeline if it fails before returning that label. A mismatched or malformed
 * result is itself an open failure.
 */
export async function monitorFreshWindowOpen(
  requestedLabel: string,
  action: () => Promise<unknown>,
): Promise<{ kind: "fresh"; label: string }> {
  const openStartedAt = Date.now();
  const timeline = startProcessTimeline({ timeout: 20_000 });
  try {
    const opened = await action();
    if (!opened || typeof opened !== "object" ||
        !("kind" in opened) || opened.kind !== "fresh" ||
        !("label" in opened) || opened.label !== requestedLabel) {
      throw new Error(`fresh-open returned ${JSON.stringify(opened)} instead of ${requestedLabel}`);
    }
    return { kind: "fresh", label: requestedLabel };
  } catch (error) {
    timeline.sample();
    writeRecord({
      issue: 781,
      phase: "open-failed",
      requestedLabel,
      openStartedAt,
      openFailedAt: Date.now(),
      openError: String(error),
      nativeBeforeOpen: timeline.samples[0],
      nativeDuringOpen: timeline.samples,
      baselineRendererDisappearances: timeline.baselineRendererDisappearances(),
      observedRendererLifetimes: timeline.observedRendererLifetimes(),
      untrackedRendererObservations: timeline.untrackedRendererObservations(),
    });
    throw error;
  } finally {
    timeline.stop();
  }
}

export interface FreshWindowSelectionEvidence {
  /** Record why no new handle exposed the label; the caller rethrows. */
  failed(error: unknown): void;
  /**
   * Record the selected handle. Label and process state are persisted before
   * the page snapshot, because that snapshot can itself hang or lose the session.
   */
  selected(handle: string): Promise<void>;
}

/** Start sampling before waiting for a new handle to expose `requestedLabel`. */
export function beginFreshWindowSelection(
  requestedLabel: string,
  existingHandles: readonly string[],
  collect: ProcessSampler = sampleNativeProcesses,
): FreshWindowSelectionEvidence {
  lastSelection = null;
  const selectionStartedAt = Date.now();
  const timeline = startProcessTimeline({ timeout: 20_000, collect });
  return {
    failed(error) {
      timeline.sample();
      writeRecord({
        issue: 781,
        phase: "selection-failed",
        requestedLabel,
        selectionStartedAt,
        selectionFailedAt: Date.now(),
        selectionError: String(error),
        existingHandles: [...existingHandles],
        nativeBeforeSelection: timeline.samples[0],
        nativeDuringSelection: timeline.samples,
        baselineRendererDisappearances: timeline.baselineRendererDisappearances(),
        observedRendererLifetimes: timeline.observedRendererLifetimes(),
        untrackedRendererObservations: timeline.untrackedRendererObservations(),
      });
      timeline.stop();
    },
    async selected(handle) {
      const selectedAt = Date.now();
      const nativeAtSelection = boundNativeProcessSample(collect());
      const selectedRenderer = newestRenderer(nativeAtSelection);
      timeline.focusRenderer(selectedRenderer, selectedAt);
      let record: FreshWindowSelected = {
        issue: 781,
        phase: "selected",
        requestedLabel,
        handle,
        selectedAt,
        pageAtSelection: null,
        nativeAtSelection,
      };
      lastSelection = record;
      writeRecord(record);
      try {
        const pageAtSelection = await captureFreshWindowPage();
        timeline.sample();
        record = {
          ...record,
          pageAtSelection,
          nativeDuringPageSnapshot: timeline.samples,
          pageSnapshotRendererFirstMissingAt: timeline.firstMissingAt(selectedRenderer),
        };
        lastSelection = record;
        writeRecord(record);
      } finally {
        timeline.stop();
      }
    },
  };
}

export interface FreshWindowLookupEvidence {
  /** Replay the selection record with lookup evidence; the caller rethrows. */
  failed(error: unknown): void;
  /** Always call: stops the sampler. */
  stop(): void;
}

/**
 * Sample while the first element lookup in the selected fresh window is
 * pending. A lost session cannot answer another WebDriver command, so the
 * failure record uses process evidence only.
 */
export function beginFreshWindowLookup(
  selector: string,
  timeout: number,
  collect: ProcessSampler = sampleNativeProcesses,
): FreshWindowLookupEvidence {
  const lookupStartedAt = Date.now();
  const selection = lastSelection;
  const selectedRenderer = newestRenderer(selection?.nativeAtSelection ?? null);
  const timeline = startProcessTimeline({
    timeout,
    collect,
    extraRenderers: selectedRenderer ? [selectedRenderer] : [],
  });
  return {
    failed(error) {
      timeline.sample();
      if (!selection) return;
      writeRecord({
        ...selection,
        phase: "lookup-failed",
        lookup: { selector, startedAt: lookupStartedAt, failedAt: Date.now(), error: String(error) },
        nativeAfterFailure: timeline.samples.at(-1),
        nativeDuringLookup: timeline.samples,
        selectedRendererAtSelection: selectedRenderer,
        selectedRendererFirstMissingAt: timeline.firstMissingAt(selectedRenderer),
      });
    },
    stop: () => timeline.stop(),
  };
}
