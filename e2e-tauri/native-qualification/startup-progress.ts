/**
 * Diagnostic reader for `Startup(webview-progress)` lines (#936).
 *
 * The page mirrors each startup mark to the native log as it is recorded, plus
 * a bounded heartbeat while startup is pending (see
 * `src/lib/state/startup-timing.ts`). This module is deliberately separate
 * from `readiness.ts`: the attributed startup parser that decides readiness
 * and builds the report never reads progress lines (#696), so this summary can
 * only describe a failure, never qualify a sample.
 */

export interface StartupProgressEvent {
  mark: string;
  /** Offset from the page's boot origin, on the webview clock. */
  webviewMs: number;
  /** Native receipt time since app run, on the `native-ready` clock. */
  appRunMs: number;
}

export interface StartupProgressSummary {
  window: string;
  /** Milestones in log order, heartbeats excluded. */
  marks: StartupProgressEvent[];
  /** The last milestone the page reported, or null if it reported none. */
  lastMark: StartupProgressEvent | null;
  /** Heartbeats logged after the last milestone (all of them if none). */
  heartbeatsAfterLastMark: number;
  lastHeartbeat: StartupProgressEvent | null;
}

const PROGRESS_LINE =
  /Startup\(webview-progress\):\s*window=(\S+)\s+mark=([a-z][a-z0-9-]*)\s+webview-ms=([\d.]+)\s+app-run-ms=([\d.]+)/g;

export function summarizeStartupProgress(
  log: string,
  window = "main",
): StartupProgressSummary {
  const marks: StartupProgressEvent[] = [];
  let lastHeartbeat: StartupProgressEvent | null = null;
  let heartbeatsAfterLastMark = 0;
  for (const match of log.matchAll(PROGRESS_LINE)) {
    if (match[1] !== window) continue;
    const event = {
      mark: match[2],
      webviewMs: Number(match[3]),
      appRunMs: Number(match[4]),
    };
    if (event.mark === "heartbeat") {
      lastHeartbeat = event;
      heartbeatsAfterLastMark += 1;
    } else {
      marks.push(event);
      heartbeatsAfterLastMark = 0;
    }
  }
  return {
    window,
    marks,
    lastMark: marks.at(-1) ?? null,
    heartbeatsAfterLastMark,
    lastHeartbeat,
  };
}

/** One human-readable clause for a failure message. */
export function describeStartupProgress(summary: StartupProgressSummary): string {
  const { window, lastMark, lastHeartbeat, heartbeatsAfterLastMark } = summary;
  const beat = lastHeartbeat
    ? `, last heartbeat at webview ${lastHeartbeat.webviewMs.toFixed(1)}ms (app-run ${lastHeartbeat.appRunMs.toFixed(1)}ms)`
    : "";
  if (!lastMark) {
    return `${window} progress: no marks reported, ${heartbeatsAfterLastMark} heartbeat(s)${beat}`;
  }
  return (
    `${window} progress: last mark ${lastMark.mark} at webview ${lastMark.webviewMs.toFixed(1)}ms ` +
    `(app-run ${lastMark.appRunMs.toFixed(1)}ms), ${heartbeatsAfterLastMark} heartbeat(s) after it${beat}`
  );
}
