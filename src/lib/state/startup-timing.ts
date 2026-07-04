/**
 * Cold-start timing instrumentation.
 *
 * Anchors at `window.__BOOT_T0__` (set in app.html's head script — the earliest
 * point JS runs, before the app bundle loads) and records boot milestones.
 * Once the first directory listing is visible, forwards a single summary line
 * to the Rust log via the `log_startup_timing` command. Routing through the
 * backend log means the numbers are durable in a release binary (written to the
 * log file, no devtools required) and sit next to the Rust `Startup:` line, so
 * the backend and frontend halves of cold start can be read together.
 *
 * Marks are relative to t0 in milliseconds. The reported value is a one-shot:
 * `reportFirstPaint` is idempotent (only the first call wins) so repeated
 * navigations or HMR can't skew it.
 */

import { invoke } from "$lib/api/files";

type Mark = { name: string; t: number };

const t0: number =
  (typeof window !== "undefined" && (window as { __BOOT_T0__?: number }).__BOOT_T0__) ||
  (typeof performance !== "undefined" ? performance.now() : 0);

const marks: Mark[] = [];
let reported = false;

/** Record a named milestone, measured from boot t0 (ms). */
export function markStartup(name: string): void {
  if (reported) return;
  const t = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
  marks.push({ name, t });
}

/**
 * Report cold start as complete (first directory listing visible). Idempotent.
 * Sends a compact summary to the Rust log and the dev console.
 */
export function reportFirstPaint(): void {
  if (reported) return;
  // Record the final milestone BEFORE latching `reported` — markStartup()
  // early-returns once reported is true, so setting the guard first would drop
  // this mark.
  markStartup("list-visible");
  reported = true;

  const total = marks.length ? marks[marks.length - 1].t : 0;
  const summary = marks.map((m) => `${m.name}=${m.t.toFixed(1)}ms`).join(" ");
  const line = `Startup(webview): ${summary} total=${total.toFixed(1)}ms`;

  if (import.meta.env.DEV) {
    console.info(`[perf] ${line}`);
  }

  // Fire-and-forget; never let timing telemetry affect the app. The command is
  // absent in mock/browser mode (invoke rejects) — swallow that quietly.
  void invoke("log_startup_timing", { summary: line }).catch(() => {});
}
