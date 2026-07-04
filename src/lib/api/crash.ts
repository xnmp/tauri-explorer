/**
 * Crash reporting bridge (#184).
 * Local capture only: panics land in files via the Rust panic hook; frontend
 * errors are forwarded into the rotating backend logs. Nothing leaves the
 * machine unless the user opens the pre-filled GitHub issue themselves.
 */

import { invoke } from "./files";

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
    forward(`uncaught: ${event.message}${where}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      event.reason instanceof Error
        ? `${event.reason.message}\n${event.reason.stack ?? ""}`
        : String(event.reason);
    forward(`unhandled rejection: ${reason}`);
  });
}
