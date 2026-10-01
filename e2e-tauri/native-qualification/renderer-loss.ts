/**
 * Renderer loss in a macOS startup sample (#942).
 *
 * The app logs `Renderer(web-content-terminated)` whenever a WKWebView's
 * WebContent process dies, then logs its `Renderer(recovery)` decision and
 * usually reloads the page. A reload hides the loss from the user, so it must
 * not hide it from qualification: any termination line fails the sample, even
 * one whose startup markers had already completed (#936 found 2 of 3 crashes
 * in "passing" samples). The reloaded document boots a second time, so marks
 * logged after the first loss belong to a different document; failure
 * summaries describe only the document that was lost.
 *
 * This module also reads the evidence that identifies the dead page: the
 * crash report (`.ips`) WebKit's process writes, and unified-log lines that
 * pair a WebContent `PID=` with its `webPageID=`.
 */
import { describeStartupProgress, summarizeStartupProgress, type StartupProgressSummary } from "./startup-progress";

export const RENDERER_TERMINATED_MARKER = "Renderer(web-content-terminated)";
const RECOVERY_MARKER = "Renderer(recovery)";

export interface RendererTermination {
  window: string | null;
  webview: string | null;
  epochMs: number | null;
  /** Time since app run on the `native-ready` clock. */
  appRunMs: number | null;
  /** WebKitGTK's termination reason (`crashed`, …); macOS reports none. */
  reason: string | null;
  /** The app's `Renderer(recovery)` decision for this window, if logged after it. */
  recovery: string | null;
  /** The line as logged, so format drift can never hide a loss. */
  line: string;
}

function field(line: string, name: string): string | null {
  return new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(line)?.[1] ?? null;
}

function finiteField(line: string, name: string): number | null {
  const raw = field(line, name);
  const value = Number(raw);
  return raw !== null && Number.isFinite(value) ? value : null;
}

/** Every renderer termination in log order. Any line naming the marker counts. */
export function findRendererTerminations(log: string): RendererTermination[] {
  const lines = log.split("\n");
  const terminations: RendererTermination[] = [];
  lines.forEach((line, index) => {
    const at = line.indexOf(RENDERER_TERMINATED_MARKER);
    if (at < 0) return;
    const body = line.slice(at + RENDERER_TERMINATED_MARKER.length).replace(/^:\s*/, " ");
    const window = field(body, "window");
    const recoveryLine = lines.slice(index + 1).find((candidate) =>
      candidate.includes(RECOVERY_MARKER) && field(candidate, "window") === window);
    terminations.push({
      window,
      webview: field(body, "webview"),
      epochMs: finiteField(body, "epoch-ms"),
      appRunMs: finiteField(body, "app-run-ms"),
      reason: field(body, "reason"),
      recovery: recoveryLine ? (/decision=.*$/.exec(recoveryLine.trim())?.[0] ?? null) : null,
      line: line.trim(),
    });
  });
  return terminations;
}

/** The log up to (not including) the first renderer termination. */
export function logBeforeRendererLoss(log: string): string {
  const at = log.indexOf(RENDERER_TERMINATED_MARKER);
  if (at < 0) return log;
  const lineStart = log.lastIndexOf("\n", at) + 1;
  return log.slice(0, lineStart);
}

function describeTermination(termination: RendererTermination): string {
  const when = termination.appRunMs === null
    ? "at an unrecorded time"
    : `at app-run ${termination.appRunMs.toFixed(1)}ms`;
  return (
    `window=${termination.window ?? "unknown"} WebContent terminated` +
    `${termination.reason ? ` (${termination.reason})` : ""} ${when}` +
    `${termination.recovery ? ` (${termination.recovery})` : " (no recovery decision logged)"}`
  );
}

/**
 * A sample whose log records renderer loss. Fatal on sight: the qualifier
 * neither waits for the timeout nor lets a completed marker set or a
 * successful reload turn it into a pass.
 */
export class MacRendererLossError extends Error {
  readonly progress: StartupProgressSummary;

  constructor(readonly terminations: readonly RendererTermination[], log: string) {
    const progress = summarizeStartupProgress(logBeforeRendererLoss(log));
    super(
      `renderer lost: ${terminations.map(describeTermination).join("; ")}` +
        `; before the loss, ${describeStartupProgress(progress)}`,
    );
    this.name = "MacRendererLossError";
    this.progress = progress;
  }
}

/** Throw if the log records renderer loss. */
export function assertNoRendererLoss(log: string): void {
  const terminations = findRendererTerminations(log);
  if (terminations.length > 0) throw new MacRendererLossError(terminations, log);
}

export interface CrashReportIdentity {
  pid: number | null;
  procName: string | null;
  bundleId: string | null;
  /** WebKit's bundle build, e.g. 21624.5.1.11.3. */
  buildVersion: string | null;
  osVersion: string | null;
  captureTime: string | null;
  bugType: string | null;
}

/**
 * Identify the process a `.ips` crash report describes. The first line is a
 * JSON header; the body is JSON too but may have been truncated by the copy
 * bound, so its fields are read by pattern rather than parsed.
 */
export function parseCrashReportIdentity(text: string): CrashReportIdentity | null {
  const newline = text.indexOf("\n");
  const headerText = newline < 0 ? text : text.slice(0, newline);
  let header: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(headerText);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      header = parsed as Record<string, unknown>;
    }
  } catch {
    // Not an .ips header; the body patterns below may still identify it.
  }
  const body = newline < 0 ? "" : text.slice(newline + 1);
  const bodyString = (name: string): string | null =>
    new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(body)?.[1] ?? null;
  const pidMatch = /"pid"\s*:\s*(\d+)/.exec(body);
  const headerString = (name: string): string | null =>
    typeof header[name] === "string" ? (header[name] as string) : null;
  const identity: CrashReportIdentity = {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    procName: bodyString("procName") ?? headerString("name"),
    bundleId: headerString("bundleID"),
    buildVersion: headerString("build_version"),
    osVersion: headerString("os_version"),
    captureTime: bodyString("captureTime") ?? headerString("timestamp"),
    bugType: headerString("bug_type"),
  };
  return Object.values(identity).every((value) => value === null) ? null : identity;
}

export interface WebPageProcess {
  pid: number;
  webPageIds: number[];
  /** A line pairing this pid with a page also reported its termination. */
  terminated: boolean;
}

/**
 * WebKit's UI-process log prefixes page activity with
 * `[pageProxyID=…, webPageID=…, PID=…]`, which ties a WebContent pid to a
 * page even after the process is gone. Termination wording varies between
 * WebKit releases, so any paired line that mentions termination or a crash
 * marks the pid; this is evidence for a reader, never a qualification gate.
 */
export function parseWebPageProcesses(unifiedLog: string): WebPageProcess[] {
  const pages = new Map<number, { webPageIds: Set<number>; terminated: boolean }>();
  for (const line of unifiedLog.split("\n")) {
    const pid = /\bPID=(\d+)/.exec(line);
    const page = /\bwebPageID=(\d+)/.exec(line);
    // PID=0 tags a page whose process has not launched yet.
    if (!pid || !page || Number(pid[1]) === 0) continue;
    const entry = pages.get(Number(pid[1])) ?? { webPageIds: new Set<number>(), terminated: false };
    entry.webPageIds.add(Number(page[1]));
    if (/terminat|crash/i.test(line)) entry.terminated = true;
    pages.set(Number(pid[1]), entry);
  }
  return [...pages.entries()]
    .map(([pid, { webPageIds, terminated }]) => ({
      pid,
      webPageIds: [...webPageIds].sort((a, b) => a - b),
      terminated,
    }))
    .sort((a, b) => a.pid - b.pid);
}
