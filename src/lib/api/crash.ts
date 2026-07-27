/**
 * Crash reporting bridge (#184, #302).
 * Local capture only: panics land in files via the Rust panic hook; uncaught
 * webview errors are both mirrored into the rotating backend logs AND recorded
 * as crash files so the next-launch notice can offer them exactly like a Rust
 * crash. Nothing leaves the machine unless the user opens the pre-filled
 * GitHub issue themselves.
 */

import { invoke } from "./files";
import { dedupeFrontendCrash, recentLogsSection } from "$lib/domain/crash-report";
import { boundedGitHubIssueUrl } from "$lib/domain/user-report";

export interface CrashReport {
  fileName: string;
  contents: string;
}

const REPO_ISSUES_URL = "https://github.com/xnmp/tauri-explorer/issues/new";
/** GitHub caps URLs around 8k; leave headroom for encoding expansion. */
const MAX_BODY_CHARS = 4000;

/** Fetch-and-consume the newest unseen crash report, if any. */
export function takeCrashReport(): Promise<CrashReport | null> {
  return invoke<CrashReport | null>("take_crash_report");
}

/** Forward a webview error into the backend's rotating log files. */
export function logFrontendError(message: string): Promise<void> {
  return invoke<void>("log_frontend_error", { message });
}

/**
 * Persist a webview error as a local crash file (#302), so the next launch's
 * crash notice can offer it exactly like a Rust panic. Local write only.
 */
export function recordFrontendCrash(message: string, stack?: string): Promise<void> {
  return invoke<void>("record_frontend_crash", { message, stack: stack ?? null });
}

/**
 * Read the tail of the rotating log file (~50 lines by default) for embedding
 * in a bug report. Reads a local file only — never transmitted by the app.
 */
export function readLogTail(maxLines = 50): Promise<string> {
  return invoke<string>("read_log_tail", { maxLines }).catch(() => "");
}

/** Build the pre-filled GitHub issue URL for a crash report. */
export function crashIssueUrl(report: CrashReport): string {
  const firstPanicLine =
    report.contents
      .split("\n")
      .find((line) => line.startsWith("panic: "))
      ?.slice("panic: ".length) ?? "unknown";
  const title = `Crash: ${firstPanicLine.slice(0, 80)}`;
  const truncated =
    report.contents.length > MAX_BODY_CHARS
      ? `${report.contents.slice(0, MAX_BODY_CHARS)}\n… (truncated — full report in ${report.fileName})`
      : report.contents;
  const body = `The app crashed. Crash report (\`${report.fileName}\`):\n\n\`\`\`\n${truncated}\n\`\`\`\n`;
  return `${REPO_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
}

export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

/**
 * Pre-filled GitHub issue URL for a user-initiated bug report (#197, #302).
 *
 * When a `logTail` is supplied it is appended as a "Recent logs" section,
 * trimmed oldest-line-first so the whole URL stays under the length cap.
 *
 * Consent/privacy: the logs are placed into the GitHub *new issue form*, which
 * the user reviews and must click "Submit" on before anything is sent. The app
 * itself performs no network call — it only opens the pre-filled form.
 */
export function bugReportUrl(info: AppInfo, logTail = ""): string {
  const baseBody = [
    "## What happened?",
    "",
    "<!-- What did you do, what did you expect, what happened instead? -->",
    "",
    "## Steps to reproduce",
    "",
    "1. ",
    "",
    "---",
    `- Tauri Explorer: v${info.version}`,
    `- OS: ${info.os} (${info.arch})`,
    "- Logs: Command Palette → \"Open Logs Folder\" (attach the latest file if relevant)",
    "",
  ].join("\n");

  let logBudget = 3500;
  let url = boundedGitHubIssueUrl("Bug: ", baseBody);
  while (logBudget > 0) {
    const section = recentLogsSection(logTail, logBudget);
    const body = section ? `${baseBody}\n${section}` : baseBody;
    url = boundedGitHubIssueUrl("Bug: ", body);
    if (url || !section) break;
    logBudget -= 400;
  }
  // The fixed template itself is well below the shared bound.
  return url ?? boundedGitHubIssueUrl("Bug: ", baseBody)!;
}

/** Open an https URL in the system browser. */
export function openExternalUrl(url: string): Promise<void> {
  return invoke<void>("open_external_url", { url });
}

let forwardedErrors = 0;
/** Cap per-session forwarding so an error loop can't flood the logs. */
const MAX_FORWARDED_ERRORS = 20;

function forward(message: string): void {
  if (forwardedErrors >= MAX_FORWARDED_ERRORS) return;
  forwardedErrors++;
  void logFrontendError(message).catch(() => {
    // Logging must never throw into the error handler itself.
  });
}

/** Messages already recorded as crashes this session (dedupe key set). */
let recordedCrashKeys: ReadonlySet<string> = new Set();

/**
 * Record a webview error as a crash file, deduping identical messages within
 * the session so a repeating error yields one report, not a burst.
 */
function capture(message: string, stack?: string): void {
  const { record, seen } = dedupeFrontendCrash(recordedCrashKeys, message);
  recordedCrashKeys = seen;
  if (!record) return;
  void recordFrontendCrash(message, stack).catch(() => {
    // A failed crash write must never re-enter the error handler.
  });
}

/**
 * Install window-level error handlers that mirror uncaught frontend errors
 * into the backend log files. Idempotent per window.
 */
let installed = false;
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    const message = `uncaught: ${event.message}${where}`;
    forward(message);
    capture(message, event.error instanceof Error ? event.error.stack : undefined);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const isError = event.reason instanceof Error;
    const message = isError
      ? `unhandled rejection: ${event.reason.message}`
      : `unhandled rejection: ${String(event.reason)}`;
    forward(
      isError ? `${message}\n${(event.reason as Error).stack ?? ""}` : message,
    );
    capture(message, isError ? (event.reason as Error).stack : undefined);
  });
}
