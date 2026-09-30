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
 * monotonic total before the sample is rejected. Ordinary scheduling jitter
 * between the two clocks is sub-millisecond; anything beyond this is a clock
 * step or a log that does not describe a single run.
 */
const CORRELATION_TOLERANCE_MS = 5;

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
  if (phases.unattributedMs < -CORRELATION_TOLERANCE_MS) {
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
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
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
      fail(
        new Error(
          `application exited before startup qualification completed (code ${code}, signal ${signal ?? "none"})`,
        ),
      );
    };
    const onError = (error: Error): void => {
      fail(new Error(`application process error: ${error.message}`));
    };
    const succeedAfterSurvival = (
      measurement: AttributedMacStartupMeasurement,
    ): void => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      survivalTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          onExit(child.exitCode, child.signalCode);
          return;
        }
        if (completed) return;
        completed = true;
        cleanup();
        resolve(measurement);
      }, options.survivalMs);
    };
    const inspectLog = (): void => {
      if (survivalTimer || completed) return;
      try {
        succeedAfterSurvival(parseDirectProcessStartupLog(readLog(), options));
      } catch {
        // Keep collecting the scenario's required native markers until the bound.
      }
    };

    const timeoutTimer = setTimeout(
      () =>
        fail(new Error(`startup markers missing after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    const pollTimer = setInterval(inspectLog, options.pollMs ?? 25);
    child.once("exit", onExit);
    child.once("error", onError);
    inspectLog();
  });
}
