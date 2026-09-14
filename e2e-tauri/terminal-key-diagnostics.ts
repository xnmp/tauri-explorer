import fs from "node:fs";
import path from "node:path";
import { collectNativeProcessEvidence, type NativeProcessEvidence } from "./fresh-window-diagnostics";

/** DOM-only state observed around the native Ctrl+Q probe. */
export interface TerminalKeyProbeSnapshot {
  terminalText: string | null;
  activeElement: { tag: string; classes: string } | null;
  terminalDisplayed: boolean;
  modalText: string | null;
}

/**
 * Artifact retained when WebDriver does not deliver Ctrl+Q to the raw PTY
 * probe. The pre-key snapshot distinguishes focus/event delivery from a
 * renderer or driver loss without issuing another WebDriver command after the
 * failed probe.
 */
export interface TerminalKeyOwnershipDiagnostics {
  issue: 709;
  phase: "before-key" | "probe-failed";
  capturedAt: number;
  probe: TerminalKeyProbeSnapshot | { error: string };
  native: NativeProcessEvidence | { error: string };
  error?: string;
}

/**
 * Persist a diagnostic as a best-effort native-run artifact. The caller keeps
 * the actual probe assertion authoritative, so an unwritable log directory
 * never turns a passing run into a failure or hides the original failure.
 */
export function writeTerminalKeyOwnershipDiagnostics(
  record: TerminalKeyOwnershipDiagnostics,
  directory: string,
): string | null {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `${record.capturedAt}-${record.phase}.json`);
    fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`);
    return destination;
  } catch {
    return null;
  }
}

export interface TerminalKeyProbeActions {
  /** The only renderer read around the potentially session-losing key command. */
  captureProbe: () => Promise<TerminalKeyProbeSnapshot | { error: string }>;
  sendKey: () => Promise<void>;
  waitForDelivery: () => Promise<unknown>;
}

export interface TerminalKeyProbeDiagnosticOptions {
  applicationPath: string;
  directory: string;
  now?: () => number;
  collectNative?: () => NativeProcessEvidence | { error: string };
  write?: (record: TerminalKeyOwnershipDiagnostics, directory: string) => string | null;
}

export interface TerminalKeyProbeObserver {
  captureBeforeKey: () => Promise<void>;
  recordFailure: (error: unknown) => void;
}

const terminalDeliveryTimeoutMessage = "terminal-hosted key probe never received Ctrl+Q";

function isCtrlQ(keys: unknown): boolean {
  return Array.isArray(keys) && keys.length === 2 && keys[0] === "Control" && keys[1] === "q";
}

function isTerminalDeliveryWait(options: unknown): boolean {
  return typeof options === "object"
    && options !== null
    && "timeoutMsg" in options
    && options.timeoutMsg === terminalDeliveryTimeoutMessage;
}

/**
 * The production WDIO command boundary around the immutable smoke spec. A
 * failed delivery is recorded before control returns to the spec's catch,
 * which may be unable to read the renderer after a lost WebDriver session.
 */
export function createTerminalKeyProbeCommandBoundary(observer: TerminalKeyProbeObserver) {
  return {
    keys: async <T>(keys: unknown, command: () => Promise<T>): Promise<T> => {
      if (!isCtrlQ(keys)) return command();
      await observer.captureBeforeKey();
      try {
        return await command();
      } catch (error) {
        observer.recordFailure(error);
        throw error;
      }
    },
    waitUntil: async <T>(options: unknown, command: () => Promise<T>): Promise<T> => {
      if (!isTerminalDeliveryWait(options)) return command();
      try {
        return await command();
      } catch (error) {
        observer.recordFailure(error);
        throw error;
      }
    },
  };
}

/**
 * Create a recorder which can surround a native key command without requiring
 * the smoke spec itself to carry harness diagnostics. Once a failure is
 * recorded, later hook notifications are ignored so the first native error is
 * preserved and the artifact remains unambiguous.
 */
export function createTerminalKeyProbeObserver(
  captureProbe: () => Promise<TerminalKeyProbeSnapshot | { error: string }>,
  options: TerminalKeyProbeDiagnosticOptions,
): TerminalKeyProbeObserver {
  const now = options.now ?? Date.now;
  const collectNative = options.collectNative
    ?? (() => collectNativeProcessEvidence({ applicationPath: options.applicationPath }));
  const write = options.write ?? writeTerminalKeyOwnershipDiagnostics;
  let beforeKey: TerminalKeyOwnershipDiagnostics | null = null;
  let recordedFailure = false;

  return {
    captureBeforeKey: async () => {
      let probe: TerminalKeyProbeSnapshot | { error: string };
      try {
        probe = await captureProbe();
      } catch (error) {
        probe = { error: String(error) };
      }
      beforeKey = {
        issue: 709,
        phase: "before-key",
        capturedAt: now(),
        probe,
        native: collectNative(),
      };
      write(beforeKey, options.directory);
    },
    recordFailure: (error) => {
      if (!beforeKey || recordedFailure) return;
      recordedFailure = true;
      const failure: TerminalKeyOwnershipDiagnostics = {
        ...beforeKey,
        phase: "probe-failed",
        capturedAt: now(),
        native: collectNative(),
        error: String(error),
      };
      const artifact = write(failure, options.directory);
      console.error("[terminal-key-diagnostics]", JSON.stringify({ artifact, failure }));
    },
  };
}

/**
 * Preserve the native command boundary: one renderer-side sample before
 * Ctrl+Q, then only observation-safe process evidence if WebDriver cannot
 * observe the raw PTY result. This deliberately performs no retry or
 * renderer read after a failed delivery.
 */
export async function runTerminalKeyProbeDiagnostics(
  actions: TerminalKeyProbeActions,
  options: TerminalKeyProbeDiagnosticOptions,
): Promise<void> {
  const observer = createTerminalKeyProbeObserver(actions.captureProbe, options);
  await observer.captureBeforeKey();

  try {
    await actions.sendKey();
    await actions.waitForDelivery();
  } catch (error) {
    observer.recordFailure(error);
    throw error;
  }
}
