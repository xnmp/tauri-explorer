/**
 * Renderer loss in a macOS startup sample (#942).
 *
 * The app logs `Renderer(web-content-terminated)` when a WebContent process
 * dies, then `Renderer(recovery): … decision=…`, and reloads the main window
 * (parked warm windows are retired). A sample with a loss is never a timing
 * measurement. It is a recovered loss when every decision is a recovery and
 * the main window reaches `native-ready` exactly once after its last loss;
 * otherwise (exhausted or failed reload, no decision, no recovery within the
 * bound, unattributable second boot) the sample fails.
 */
import { describeStartupProgress, summarizeStartupProgress } from "./startup-progress";

/**
 * Recovered losses a run may replace before it fails. CI measured 6 losses in
 * 409 launches (~1.5%), so a 30-sample run expects ~0.5: P(more than 3) is
 * ~0.2%, while a 10% loss rate exceeds it ~40% of the time.
 */
export const MAX_RECOVERED_RENDERER_LOSSES = 3;

const TERMINATED = "Renderer(web-content-terminated)";
const RECOVERY = "Renderer(recovery)";
const FAILED_DECISION = /decision=(exhausted|reload-failed)\b/;

export interface RendererTermination {
  window: string | null;
  appRunMs: number | null;
  /** WebKitGTK's reason (`crashed`, …); macOS reports none. */
  reason: string | null;
  /** The app's first recovery decision for this window after the loss. */
  decision: string | null;
}

export type RendererLossOutcome =
  | { status: "none" }
  | { status: "pending" | "recovered"; terminations: RendererTermination[] }
  | { status: "failed"; terminations: RendererTermination[]; reason: string };

const field = (line: string, name: string): string | null =>
  new RegExp(`\\s${name}=(\\S+)`).exec(line)?.[1] ?? null;

/** Every loss in log order. Any line naming the marker counts, whatever its fields. */
export function findRendererTerminations(log: string): RendererTermination[] {
  const lines = log.split("\n");
  return lines.flatMap((line, index) => {
    if (!line.includes(TERMINATED)) return [];
    const window = field(line, "window");
    const appRun = Number(field(line, "app-run-ms"));
    const recovery = lines.slice(index + 1)
      .find((later) => later.includes(RECOVERY) && field(later, "window") === window);
    return [{
      window,
      appRunMs: Number.isFinite(appRun) && field(line, "app-run-ms") !== null ? appRun : null,
      reason: field(line, "reason"),
      decision: recovery ? field(recovery, "decision") : null,
    }];
  });
}

const count = (lines: readonly string[], marker: string): number =>
  lines.filter((line) => new RegExp(`${marker}:\\s*window=main\\s`).test(line)).length;

/** Pure: where a sample's renderer losses stand. */
export function assessRendererLoss(log: string): RendererLossOutcome {
  const terminations = findRendererTerminations(log);
  if (terminations.length === 0) return { status: "none" };
  const lines = log.split("\n");
  const failed = lines.find((line) => line.includes(RECOVERY) && FAILED_DECISION.test(line));
  if (failed) {
    return { status: "failed", terminations, reason: `recovery ${FAILED_DECISION.exec(failed)![0]}` };
  }
  if (terminations.some(({ decision }) => decision === null)) return { status: "pending", terminations };
  const lastMainLoss = lines.reduce(
    (last, line, index) => (line.includes(TERMINATED) && field(line, "window") === "main" ? index : last), -1);
  const after = lines.slice(lastMainLoss + 1);
  const ready = count(after, "Startup\\(native-ready\\)");
  if (ready === 0) return { status: "pending", terminations };
  if (ready > 1 || count(after, "Startup\\(webview\\)") !== 1) {
    return { status: "failed", terminations, reason: "the recovered main document's markers cannot be attributed" };
  }
  return { status: "recovered", terminations };
}

/** The log up to the first loss: what the lost document reported. */
export function logBeforeRendererLoss(log: string): string {
  const at = log.indexOf(TERMINATED);
  return at < 0 ? log : log.slice(0, log.lastIndexOf("\n", at) + 1);
}

export function describeRendererLoss(terminations: readonly RendererTermination[]): string {
  return terminations.map(({ window, appRunMs, reason, decision }) =>
    `window=${window ?? "unknown"} WebContent terminated${reason ? ` (${reason})` : ""} ` +
      `${appRunMs === null ? "at an unrecorded time" : `at app-run ${appRunMs.toFixed(1)}ms`}` +
      ` (${decision ? `decision=${decision}` : "no recovery decision"})`).join("; ");
}

/**
 * A sample that lost a renderer. `recovered` samples are recorded and replaced
 * rather than measured; the others fail the run.
 */
export class MacRendererLossError extends Error {
  readonly recovered: boolean;

  constructor(readonly terminations: readonly RendererTermination[], log: string, failure: string | null) {
    super(
      `renderer lost${failure === null ? " and recovered" : ""}: ${describeRendererLoss(terminations)}` +
        `${failure === null ? "" : `; ${failure}`}` +
        `; before the loss, ${describeStartupProgress(summarizeStartupProgress(logBeforeRendererLoss(log)))}`,
    );
    this.name = "MacRendererLossError";
    this.recovered = failure === null;
  }
}

/** Identify a WebContent crash report (`.ips`): its pid and WebKit build. */
export function webContentCrashReport(text: string): { pid: number; buildVersion: string | null } | null {
  if (!text.includes("com.apple.WebKit.WebContent")) return null;
  const pid = /"pid"\s*:\s*(\d+)/.exec(text);
  return pid
    ? { pid: Number(pid[1]), buildVersion: /"build_version"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? null }
    : null;
}
