import { assessRendererLoss, findRendererTerminations, MacRendererLossError } from "./renderer-loss";
import { describeStartupProgress, summarizeStartupProgress, type StartupProgressSummary } from "./startup-progress";
import type { AttributedMacStartupMeasurement, MacStartupPhases, NativeStartupChild } from "./types";

function durationToMilliseconds(value: string, unit: string): number {
  const duration = Number(value);
  switch (unit) {
    case "ns":
      return duration / 1_000_000;
    case "us":
    case "µs":
    case "μs":
      return duration / 1_000;
    case "ms":
      return duration;
    case "s":
      return duration * 1_000;
    default:
      throw new Error(`unsupported startup duration unit: ${unit}`);
  }
}

/**
 * How far the two wall-clock-correlated boundaries may disagree with the native
 * monotonic total before the sample is rejected: a fixed allowance for clock
 * granularity plus a rate term for wall-clock slewing over the launch.
 *
 * The rate term comes from the retained CI residuals (#936): across 7,480
 * macOS samples the most negative residual grew with launch length, about
 * -1.5ms under 3s, -2.0ms at 3-4s, -3.0ms at 4-6s, -3.8ms at 6-8s, -4.06ms at
 * 8.1s and -6.18ms at 12.3s, i.e. about 0.5ms per second, while the median
 * stayed near 0. That is the 500 ppm frequency bound of the kernel's NTP clock
 * discipline (MAXFREQ): while the wall clock is being slewed it can drift from
 * the monotonic clock by at most that rate. A fixed 5ms bound therefore
 * rejected every slow cold sample (>~10s) launched during a slew and reported
 * it as missing markers. A clock step or a log holding two runs still
 * disagrees by far more than this bound.
 */
const CORRELATION_TOLERANCE_FLOOR_MS = 5;
const WALL_CLOCK_SLEW_RATE = 0.0005;

export function correlationToleranceMs(launchTotalMs: number): number {
  return Number(
    (CORRELATION_TOLERANCE_FLOOR_MS + WALL_CLOCK_SLEW_RATE * Math.max(0, launchTotalMs)).toFixed(3),
  );
}

function requiredNumber(
  match: RegExpMatchArray | null,
  index: number,
  marker: string,
): number {
  if (!match) throw new Error(`${marker} marker missing from macOS process log`);
  const value = Number(match[index]);
  if (!Number.isFinite(value)) throw new Error(`${marker} marker is not finite`);
  return value;
}

/**
 * Parse correlated native and webview markers into user-facing phase evidence.
 * Wall-clock correlation is used only at the two cross-runtime boundaries;
 * any disagreement with the native monotonic total remains unattributed.
 */
export function parseAttributedMacStartupLog(
  log: string,
  outcomes: Pick<
    AttributedMacStartupMeasurement,
    | "firstFunctionalFrame"
    | "firstFunctionalFrameMs"
    | "inputOutcome"
    | "inputReadyMs"
  > & { measureWarm?: boolean } = {
    firstFunctionalFrame: "not-observed",
    firstFunctionalFrameMs: null,
    inputOutcome: "not-verified",
    inputReadyMs: null,
  },
): AttributedMacStartupMeasurement {
  // A sample that lost a renderer is never a measurement, even when the
  // reloaded document completed its markers (#942).
  const terminations = findRendererTerminations(log);
  if (terminations.length > 0) {
    throw new MacRendererLossError(terminations, log, "a sample with a renderer loss is not a measurement");
  }
  for (const marker of ["webview", "native-ready"]) {
    // Logged once per main-window document; taking the first of two would mix clocks.
    if ((log.match(new RegExp(`Startup\\(${marker}\\):\\s*window=main\\s`, "g")) ?? []).length > 1) {
      throw new Error(`Startup(${marker}) is recorded by more than one main-window document`);
    }
  }
  const duration = "([\\d.]+)(ns|us|µs|μs|ms|s)";
  const nativeWindow = log.match(
    new RegExp(
      `Startup\\(native-window\\):\\s*window=main\\s+app-run-epoch-ms=([\\d.]+)` +
        `\\s+process-entry-to-run=${duration}\\s+window-built=${duration}`,
    ),
  );
  const webviewLine =
    log.match(/Startup\(webview\):\s*window=main\s+[^\n]*/)?.[0] ?? null;
  const ready = log.match(
    new RegExp(
      `Startup\\(native-ready\\):\\s*window=main\\s+app-run-to-ready=${duration}\\s+receipt-epoch-ms=([\\d.]+)`,
    ),
  );
  const warm = log.match(
    new RegExp(`Startup\\(warm-activate\\):\\s*show=${duration}`),
  );

  if (!nativeWindow) throw new Error("native-window marker missing from macOS process log");
  const appRunEpochMs = requiredNumber(nativeWindow, 1, "native-window");
  const processEntryMs = durationToMilliseconds(nativeWindow[2], nativeWindow[3]);
  const windowBuiltMs = durationToMilliseconds(nativeWindow[4], nativeWindow[5]);
  const webviewMarker = (name: string): number => {
    const occurrences =
      webviewLine?.match(new RegExp(`(?<![\\w-])${name}=([\\d.]+)ms`, "g")) ?? [];
    if (occurrences.length > 1) {
      // The first occurrence wins, so a duplicate would silently move time out
      // of one phase and into the next with a zero residual to show for it.
      throw new Error(`${name} marker is recorded more than once`);
    }
    return requiredNumber(
      webviewLine?.match(new RegExp(`(?<![\\w-])${name}=([\\d.]+)ms`)) ?? null,
      1,
      name,
    );
  };
  const bootEpochMs = requiredNumber(
    webviewLine?.match(/boot-epoch-ms=([\d.]+)/) ?? null,
    1,
    "boot-epoch-ms",
  );
  const bundleExecMs = webviewMarker("bundle-exec");
  const listReadyMs = webviewMarker("list-ready");
  const settingsReadyMs = webviewMarker("settings-ready");
  const commandsReadyMs = webviewMarker("commands-ready");
  const appReadyMs = webviewMarker("app-ready");
  const uiReadyMs = webviewMarker("ui-ready");
  const webviewTotalMs = webviewMarker("total");
  if (!ready) throw new Error("native-ready marker missing from macOS process log");
  const readinessTotalMs = durationToMilliseconds(ready[1], ready[2]);
  const receiptEpochMs = requiredNumber(ready, 3, "receipt-epoch-ms");
  if (outcomes.measureWarm !== false && !warm) {
    throw new Error("warm-activate marker missing from macOS process log");
  }
  const warmShowMs = outcomes.measureWarm !== false && warm
    ? durationToMilliseconds(warm[1], warm[2])
    : null;

  if (
    listReadyMs < bundleExecMs ||
    settingsReadyMs < bundleExecMs ||
    commandsReadyMs < bundleExecMs ||
    appReadyMs < Math.max(listReadyMs, settingsReadyMs, commandsReadyMs) ||
    uiReadyMs < appReadyMs ||
    webviewTotalMs !== uiReadyMs
  ) {
    throw new Error("webview startup markers are not ordered");
  }
  const windowBuiltEpochMs = appRunEpochMs + windowBuiltMs;
  if (bootEpochMs < windowBuiltEpochMs) {
    throw new Error("document boot precedes the native window-built marker");
  }
  const uiReadyEpochMs = bootEpochMs + uiReadyMs;
  if (receiptEpochMs < uiReadyEpochMs) {
    throw new Error("readiness receipt precedes the ui-ready marker");
  }

  const phases: MacStartupPhases = {
    processEntryMs,
    nativeWindowMs: windowBuiltMs,
    frameworkNavigationMs: bootEpochMs - windowBuiltEpochMs,
    documentBootMs: bundleExecMs,
    requiredAppWorkMs: appReadyMs - bundleExecMs,
    frameSchedulingMs: uiReadyMs - appReadyMs,
    readinessIpcMs: receiptEpochMs - uiReadyEpochMs,
    unattributedMs: 0,
  };
  const attributedMs =
    phases.processEntryMs +
    phases.frameworkNavigationMs +
    phases.nativeWindowMs +
    phases.documentBootMs +
    phases.requiredAppWorkMs +
    phases.frameSchedulingMs +
    phases.readinessIpcMs;
  // The residual is measured against the full in-process window, so the
  // pre-`run` phase never inflates or deflates it. It stays a reported phase in
  // its own right and is never redistributed across the attributed phases.
  const launchTotalMs = Number((processEntryMs + readinessTotalMs).toFixed(3));
  phases.unattributedMs = Number((launchTotalMs - attributedMs).toFixed(3));
  // The residual is the whole point of this decomposition, so it must not be a
  // place for correlation failures to hide. The two epoch-correlated phases are
  // the only ones a wall-clock step (or a log holding two runs) can inflate;
  // when that happens the residual goes sharply negative instead of the phases
  // looking wrong. Reject the sample rather than publish a plausible fiction.
  if (phases.unattributedMs < -correlationToleranceMs(launchTotalMs)) {
    throw new Error(
      "correlated startup clocks disagree with the native monotonic total: " +
        `residual ${phases.unattributedMs.toFixed(3)}ms`,
    );
  }

  return {
    coldTotalMs: readinessTotalMs,
    readinessTotalMs,
    launchTotalMs,
    warmShowMs,
    phases,
    firstFunctionalFrame: outcomes.firstFunctionalFrame,
    firstFunctionalFrameMs: outcomes.firstFunctionalFrameMs,
    inputOutcome: outcomes.inputOutcome,
    inputReadyMs: outcomes.inputReadyMs,
  };
}

/**
 * The direct-process qualifier's readiness predicate. It deliberately uses the
 * SAME parser the report is built from: an independent "is it ready yet" regex
 * drifted from the emitted log format once already (#696) and, because the
 * runner only re-parsed afterwards, the drift was invisible until a Mac run.
 * Requiring the full attributed marker set also removes the race where
 * readiness was declared before the webview line had flushed.
 */
function parseDirectProcessStartupLog(
  log: string,
  options: { measureWarm?: boolean } = {},
): AttributedMacStartupMeasurement {
  return parseAttributedMacStartupLog(log, {
    firstFunctionalFrame: "not-observed",
    firstFunctionalFrameMs: null,
    inputOutcome: "not-verified",
    inputReadyMs: null,
    measureWarm: options.measureWarm,
  });
}

/**
 * The readiness bound expired. Carries what the log did show so the failure
 * reports why, instead of only that markers were missing: the attributed
 * parser's final rejection (e.g. a clock-correlation bound rather than an
 * absent marker) and the main window's last streamed progress mark (#936).
 */
export class MacStartupTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly lastRejection: string | null,
    readonly progress: StartupProgressSummary,
  ) {
    super(
      `startup markers missing after ${timeoutMs}ms` +
        `; last parser rejection: ${lastRejection ?? "none recorded"}` +
        `; ${describeStartupProgress(progress)}`,
    );
    this.name = "MacStartupTimeoutError";
  }
}

export function waitForMacStartupProcess(
  child: NativeStartupChild,
  readLog: () => string,
  options: {
    timeoutMs: number;
    survivalMs: number;
    pollMs?: number;
    measureWarm?: boolean;
  },
): Promise<AttributedMacStartupMeasurement> {
  return new Promise((resolve, reject) => {
    let completed = false;
    let survivalTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      clearTimeout(recoveryTimer);
      clearInterval(pollTimer);
      if (survivalTimer) clearTimeout(survivalTimer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const fail = (error: Error): void => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(error);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      const status = `(code ${code}, signal ${signal ?? "none"})`;
      const exit = `application exited ${status}`;
      // An exit during a loss is that loss's failure: its message leads (ADR 0021).
      const log = readLog();
      const loss = assessRendererLoss(log);
      if (loss.status !== "none") {
        const failure = loss.status === "failed" ? `${loss.reason}; ${exit}` : `${exit} before the loss recovered`;
        fail(new MacRendererLossError(loss.terminations, log, failure));
        return;
      }
      fail(new Error(`application exited before startup qualification completed ${status}`));
    };
    const onError = (error: Error): void => {
      fail(new Error(`application process error: ${error.message}`));
    };
    // A renderer loss (seen at any point, including the survival interval)
    // ends the measurement. The sample then settles as a recovered or failed
    // loss once the app's recovery is visible, within the sample bound (#942).
    const settleRendererLoss = (log: string, expired = false): boolean => {
      const outcome = assessRendererLoss(log);
      if (outcome.status === "none") return false;
      if (outcome.status === "pending" && !expired) {
        if (!recoveryTimer) {
          clearTimeout(timeoutTimer);
          clearTimeout(survivalTimer);
          recoveryTimer = setTimeout(() => settleRendererLoss(readLog(), true), options.timeoutMs);
        }
        return true;
      }
      const failure = outcome.status === "recovered" ? null
        : outcome.status === "failed" ? outcome.reason
        : `no recovery within ${options.timeoutMs}ms`;
      fail(new MacRendererLossError(outcome.terminations, log, failure));
      return true;
    };
    const succeedAfterSurvival = (
      measurement: AttributedMacStartupMeasurement,
    ): void => {
      clearTimeout(timeoutTimer);
      survivalTimer = setTimeout(() => {
        if (completed || settleRendererLoss(readLog())) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          onExit(child.exitCode, child.signalCode);
          return;
        }
        completed = true;
        cleanup();
        resolve(measurement);
      }, options.survivalMs);
    };
    let lastRejection: string | null = null;
    const inspectLog = (): void => {
      if (completed) return;
      const log = readLog();
      if (settleRendererLoss(log) || survivalTimer) return;
      try {
        succeedAfterSurvival(parseDirectProcessStartupLog(log, options));
      } catch (error) {
        // Keep collecting the scenario's required native markers until the
        // bound, but remember why so a timeout can say so.
        lastRejection = error instanceof Error ? error.message : String(error);
      }
    };

    const timeoutTimer = setTimeout(() => {
      if (settleRendererLoss(readLog())) return;
      fail(
        new MacStartupTimeoutError(
          options.timeoutMs,
          lastRejection,
          summarizeStartupProgress(readLog()),
        ),
      );
    }, options.timeoutMs);
    const pollTimer = setInterval(inspectLog, options.pollMs ?? 25);
    child.once("exit", onExit);
    child.once("error", onError);
    inspectLog();
  });
}
