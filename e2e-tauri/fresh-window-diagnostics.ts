/**
 * Always-on evidence for the first element lookup in a freshly opened native
 * window (#703).
 *
 * A Linux native run lost its WebDriver session on the first
 * `findElement(.file-list)` after a fresh child window was selected. The job
 * log could not separate "the renderer died", "the driver lost the session"
 * and "the page never rendered a file list", because nothing was recorded
 * between the successful label read and the failing lookup.
 *
 * This module is the recording seam. It is deliberately split into pure
 * classification (unit-testable without `/proc` or a driver) and thin readers,
 * and every entry point is failure-tolerant: diagnostics must never convert a
 * passing run into an error, and the failure path must work when the WebDriver
 * session is already gone (so it observes processes only, never the renderer).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parentPid, processExecutable, processIds, processStartTime } from "./native-process";

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
}

/** WebKitGTK's multi-process names. A missing `WebKitWebProcess` after a lost
 * lookup is renderer death; a surviving one points at the driver instead. */
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

/**
 * Split an observed process table into the three groups that distinguish a
 * renderer crash from a driver failure. Pure: no filesystem access.
 */
export function classifyNativeProcesses(
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
 * tolerates several matching processes.
 */
export function readLinuxProcessTable(): ProcessObservation[] {
  if (process.platform !== "linux") return [];
  return processIds().map((pid) => ({
    pid,
    executable: processExecutable(pid),
    startTime: processStartTime(pid),
    parentPid: parentPid(pid),
  }));
}

export interface NativeEvidenceOptions {
  applicationPath: string;
  read?: ProcessTableReader;
  now?: () => number;
}

/** Sample and classify the native process table; never throws. */
export function collectNativeProcessEvidence(
  options: NativeEvidenceOptions,
): NativeProcessEvidence | { error: string } {
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

/** The complete evidence bundle written for one fresh-window lookup. */
export interface FreshWindowDiagnostics {
  issue: 703;
  phase: "selected" | "lookup-failed";
  requestedLabel: string;
  handle: string;
  selectedAt: number;
  /** Renderer sample taken at successful fresh-handle selection. */
  pageAtSelection: FreshWindowPageSnapshot | { error: string } | null;
  nativeAtSelection: NativeProcessEvidence | { error: string } | null;
  /** Only present on a failed lookup; the session may already be invalid, so
   * this is process evidence only. */
  lookup?: { selector: string; failedAt: number; error: string };
  nativeAfterFailure?: NativeProcessEvidence | { error: string };
}

/**
 * Artifact file name for one record.
 *
 * Per ADR 0021 no caller-supplied string becomes a path component: the window
 * label is digested, and the raw label is retained inside the JSON body.
 */
export function diagnosticsFileName(record: FreshWindowDiagnostics): string {
  const digest = createHash("sha256").update(record.requestedLabel).digest("hex").slice(0, 12);
  return `${record.selectedAt}-${digest}-${record.phase}.json`;
}

/**
 * Write one record into the run's driver output directory, which CI uploads as
 * the WDIO failure artifact. Returns the written path, or `null` when writing
 * itself failed — a diagnostic must never mask the outcome it documents.
 */
export function writeFreshWindowDiagnostics(
  record: FreshWindowDiagnostics,
  directory: string,
): string | null {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, diagnosticsFileName(record));
    fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`);
    return destination;
  } catch {
    return null;
  }
}
