import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addQualificationFailureArtifact, writeQualificationArtifact } from "./artifacts";
import type {
  NativeProcessRow,
  NativeProcessStopOptions,
  NativeQualificationProcess,
  NativeStartupChild,
  ResourceMeasurement,
} from "./types";

export function selectNativeProcessRoot(
  rows: readonly NativeProcessRow[],
  expectedBinary: string,
): NativeProcessRow {
  const normalizedBinary = path.resolve(expectedBinary).toLowerCase();
  const roots = rows.filter(({ executable }) =>
    path.resolve(executable).toLowerCase() === normalizedBinary);
  if (roots.length === 0)
    throw new Error(`native process not found at ${expectedBinary}`);
  if (roots.length !== 1)
    throw new Error(`native process identity is ambiguous at ${expectedBinary}: ${roots.length} roots`);
  return roots[0];
}

export function measureProcessTreeRss(
  rows: readonly NativeProcessRow[],
  expectedBinary: string,
  sampledAtMs: number,
): ResourceMeasurement {
  const processIds = new Set([selectNativeProcessRoot(rows, expectedBinary).pid]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (processIds.has(row.parentPid) && !processIds.has(row.pid)) {
        processIds.add(row.pid);
        changed = true;
      }
    }
  }

  return {
    rssBytes: rows
      .filter(({ pid }) => processIds.has(pid))
      .reduce((total, { rssBytes }) => total + rssBytes, 0),
    sampledAtMs,
  };
}

export async function executeLoggedQualificationProcess<
  T extends {
    passed?: boolean;
    failureArtifacts?: readonly string[];
    runErrors?: readonly string[];
  },
>(options: {
  command: readonly string[];
  env?: NodeJS.ProcessEnv;
  reportPath: string;
  driverLogPath: string;
  additionalFailureArtifacts?: readonly string[];
  mirrorOutput?: boolean;
  createFallbackReport: (exitCode: number) => T;
}): Promise<{
  exitCode: number;
  signalCode: NodeJS.Signals | null;
  report: T;
}> {
  if (options.command.length === 0)
    throw new Error("qualification process command must not be empty");
  fs.mkdirSync(path.dirname(options.driverLogPath), { recursive: true });
  fs.rmSync(options.reportPath, { force: true });
  const logFile = fs.openSync(options.driverLogPath, "w");
  const mirrorOutput = options.mirrorOutput ?? true;
  let exitCode = 1;
  let signalCode: NodeJS.Signals | null = null;
  let processFailure: string | undefined;

  try {
    const child = spawn(options.command[0], [...options.command.slice(1)], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const relay = (chunk: Buffer, destination: NodeJS.WriteStream): void => {
      fs.writeSync(logFile, chunk);
      if (mirrorOutput) destination.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => relay(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => relay(chunk, process.stderr));

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("error", (error) => {
        const message = `qualification process error: ${error.message}`;
        processFailure = message;
        fs.writeSync(logFile, `${message}\n`);
        if (mirrorOutput) process.stderr.write(`${message}\n`);
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    exitCode = result.code ?? 1;
    signalCode = result.signal;
    if ((result.code ?? 1) !== 0 || result.signal !== null) {
      processFailure ??=
        `qualification process exited with code ${result.code ?? "null"} ` +
        `(signal ${result.signal ?? "none"})`;
    }
    if (result.signal) {
      const message = `qualification process terminated by ${result.signal}\n`;
      fs.writeSync(logFile, message);
      if (mirrorOutput) process.stderr.write(message);
    }
  } catch (error) {
    const message = `qualification process could not start: ${
      error instanceof Error ? error.message : String(error)
    }`;
    processFailure = message;
    fs.writeSync(logFile, `${message}\n`);
    if (mirrorOutput) process.stderr.write(`${message}\n`);
  } finally {
    fs.closeSync(logFile);
  }

  let report = fs.existsSync(options.reportPath)
    ? (JSON.parse(fs.readFileSync(options.reportPath, "utf8")) as T)
    : options.createFallbackReport(exitCode);
  if (processFailure) {
    report = {
      ...report,
      passed: false,
      runErrors: [...new Set([...(report.runErrors ?? []), processFailure])],
    };
  }
  if (exitCode !== 0 || !report.passed) {
    report = addQualificationFailureArtifact(report, options.driverLogPath);
    for (const artifact of options.additionalFailureArtifacts ?? []) {
      if (fs.existsSync(artifact)) {
        report = addQualificationFailureArtifact(report, artifact);
      }
    }
  }
  writeQualificationArtifact(options.reportPath, report);
  return { exitCode, signalCode, report };
}

export async function executeQualificationRun<T>(options: {
  outputPath: string;
  execute: (runErrors: string[]) => Promise<void>;
  createReport: (runErrors: readonly string[]) => T;
}): Promise<T> {
  const runErrors: string[] = [];
  let failure: unknown;
  try {
    await options.execute(runErrors);
  } catch (error) {
    failure = error;
    runErrors.push(error instanceof Error ? error.message : String(error));
  }

  let report: T;
  try {
    report = options.createReport(runErrors);
  } catch (error) {
    failure ??= error;
    runErrors.push(
      `report construction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    writeQualificationArtifact(options.outputPath, {
      passed: false,
      runErrors,
    });
    throw failure;
  }
  writeQualificationArtifact(options.outputPath, report);
  if (failure) throw failure;
  return report;
}

async function waitForProcessExit(
  child: NativeStartupChild,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopNativeQualificationProcess(
  child: NativeStartupChild,
  label: string,
  options: NativeProcessStopOptions,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let gracefulAccepted = false;
  try {
    gracefulAccepted = child.kill();
  } catch {
    // A rejected graceful signal still requires a forced cleanup attempt.
  }
  if (
    gracefulAccepted &&
    (await waitForProcessExit(child, options.gracefulTimeoutMs))
  ) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;

  let refusal: string | null = null;
  try {
    if (!child.kill("SIGKILL")) refusal = "";
  } catch (error) {
    refusal = `: ${error instanceof Error ? error.message : String(error)}`;
  }
  const exited = await waitForProcessExit(child, options.forceTimeoutMs);
  // A process that exits between the liveness check and SIGKILL makes the
  // kill fail (Windows reports the handle as gone). Only a refusal while the
  // process is still alive is a rejected force kill (#910).
  if (refusal !== null && !exited) {
    throw new Error(`${label} SIGKILL was rejected${refusal}`);
  }
  if (!exited) {
    throw new Error(
      `${label} remained alive after SIGKILL for ${options.forceTimeoutMs}ms`,
    );
  }
}

export async function stopNativeQualificationProcesses(
  processes: readonly NativeQualificationProcess[],
  options: NativeProcessStopOptions = {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 2_000,
  },
): Promise<void> {
  const results = await Promise.allSettled(
    processes
      .filter(
        (process): process is { label: string; child: NativeStartupChild } =>
          process.child !== undefined,
      )
      .map(({ label, child }) =>
        stopNativeQualificationProcess(child, label, options),
      ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        ]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(
      `native qualification cleanup failed: ${failures.join("; ")}`,
    );
  }
}

export async function stopNativeStartupProcess(
  child: NativeStartupChild,
  options: NativeProcessStopOptions = {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 2_000,
  },
): Promise<void> {
  await stopNativeQualificationProcess(
    child,
    "native startup process",
    options,
  );
}

/** Fixtures outlive the application session and are removed by onComplete,
 * after each worker has awaited native process termination. */
export function createNativeFixtureDirectory(
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root = environment.TAURI_NATIVE_CLEANUP_STATE_DIRECTORY;
  if (!root) throw new Error("native fixture ownership is unavailable before run preparation");
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error("invalid native fixture prefix");
  return fs.mkdtempSync(path.join(root, prefix));
}

/** Cross-device fixtures must stay on their requested mount; never fall back. */
export function createNativeSharedMemoryFixtureDirectory(
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return createNativeFixtureDirectory(prefix, {
    TAURI_NATIVE_CLEANUP_STATE_DIRECTORY: environment.TAURI_NATIVE_SHM_CLEANUP_STATE_DIRECTORY,
  });
}

export function createNativeProcessCleanupHooks(options: {
  environment: NodeJS.ProcessEnv;
  stateEnvironmentKey: string;
  stop: () => Promise<void>;
  temporaryRoot?: string;
  additionalFixtureRoots?: readonly { stateEnvironmentKey: string; temporaryRoot: string }[];
}): {
  prepare: () => void;
  begin: () => void;
  cleanup: () => Promise<void>;
  complete: () => void;
} {
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  const directoryPrefix = "tauri-native-cleanup-";
  const roots = [
    { stateEnvironmentKey: options.stateEnvironmentKey, temporaryRoot, prefix: directoryPrefix },
    ...(options.additionalFixtureRoots ?? []).map((root, index) => ({
      ...root, temporaryRoot: path.resolve(root.temporaryRoot), prefix: `tauri-native-fixture-${index}-`,
    })),
  ];
  if (new Set(roots.map(root => root.stateEnvironmentKey)).size !== roots.length) {
    throw new Error("native fixture roots must have distinct environment keys");
  }
  let prepared: { stateEnvironmentKey: string; directory: string }[] = [];
  let pendingMarker: string | undefined;
  const removePrepared = (): string[] => {
    const failures: string[] = [];
    const owned = prepared;
    prepared = [];
    for (const { stateEnvironmentKey, directory } of owned) {
      delete options.environment[stateEnvironmentKey];
      try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`failed to remove cleanup marker directory: ${message}`);
      }
    }
    return failures;
  };

  const assertMarkerDirectory = (candidate: string): string => {
    const resolved = path.resolve(candidate);
    const relative = path.relative(temporaryRoot, resolved);
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      !path.basename(resolved).startsWith(directoryPrefix)
    ) {
      throw new Error(`invalid native cleanup state directory: ${resolved}`);
    }
    return resolved;
  };

  const writePendingMarker = (message: string): void => {
    const configuredDirectory = options.environment[options.stateEnvironmentKey];
    if (!configuredDirectory) {
      throw new Error(`native cleanup state directory unavailable: ${message}`);
    }
    const markerDirectory = assertMarkerDirectory(configuredDirectory);
    const marker = pendingMarker ?? path.join(markerDirectory, `${process.pid}-${randomUUID()}.json`);
    writeQualificationArtifact(marker, { message });
    pendingMarker = marker;
  };

  return {
    begin: () => {
      if (pendingMarker) throw new Error("native worker cleanup is already pending");
      writePendingMarker("native worker ended without confirming process exit");
    },
    prepare: () => {
      if (prepared.length) throw new Error("native fixture roots are already prepared");
      try {
        for (const root of roots) {
          const directory = fs.mkdtempSync(path.join(root.temporaryRoot, root.prefix));
          prepared.push({ stateEnvironmentKey: root.stateEnvironmentKey, directory });
          options.environment[root.stateEnvironmentKey] = directory;
        }
      } catch (error) {
        const failures = removePrepared();
        if (failures.length) throw new AggregateError([error, ...failures], "native fixture preparation rollback failed");
        throw error;
      }
    },
    cleanup: async () => {
      try {
        await options.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writePendingMarker(message);
        throw error;
      }
      if (pendingMarker) {
        fs.rmSync(pendingMarker);
        pendingMarker = undefined;
      }
    },
    complete: () => {
      const markerDirectory = prepared[0]?.directory;
      if (!markerDirectory) return;
      const failures: string[] = [];
      try {
        failures.push(
          ...fs
            .readdirSync(markerDirectory)
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => {
              const marker = JSON.parse(
                fs.readFileSync(path.join(markerDirectory, entry), "utf8"),
              ) as { message?: unknown };
              return typeof marker.message === "string"
                ? marker.message
                : `invalid cleanup marker ${entry}`;
            }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`failed to read cleanup markers: ${message}`);
      }
      if (failures.length > 0) {
        throw new Error(
          `native qualification cleanup failed: ${failures.join("; ")}; ` +
            `fixture roots preserved: ${prepared.map(({ directory }) => directory).join(", ")}`,
        );
      }
      // Only remove fixtures after every worker confirmed native process exit.
      // A pending or unreadable marker cannot establish that guarantee.
      failures.push(...removePrepared());
      if (failures.length > 0) {
        throw new Error(
          `native qualification cleanup failed: ${failures.join("; ")}`,
        );
      }
    },
  };
}
